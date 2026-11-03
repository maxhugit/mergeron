import http.client
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import time
import uuid
import threading
import unittest
from types import SimpleNamespace
import server

class PrivateAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.TOKEN='a'*64
        cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        cls.thread=threading.Thread(target=cls.http.serve_forever,daemon=True)
        cls.thread.start()
    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown();cls.http.server_close();cls.thread.join()
    def request(self,method,path,headers=None,body=None):
        connection=http.client.HTTPConnection('127.0.0.1',self.http.server_port,timeout=2)
        connection.request(method,path,body=body,headers=headers or {})
        response=connection.getresponse();result=(response.status,json.loads(response.read()));connection.close();return result
    def test_auth_required_before_reading_upload(self):
        self.assertEqual(self.request('POST','/jobs',body=b'a')[0],401)
        self.assertEqual(self.request('GET','/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')[0],401)
    def test_oversized_upload_rejected_before_bytes(self):
        status,data=self.request('POST','/jobs',{'Authorization':'Bearer '+server.TOKEN,'X-Job-Id':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Content-Length':str(server.LIMIT+1)})
        self.assertEqual(status,413)
    def test_delete_missing_job_is_idempotent(self):
        self.assertEqual(self.request('DELETE','/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',{'Authorization':'Bearer '+server.TOKEN}),(200,{'removed':True}))
    def test_job_ids_cannot_traverse_paths(self):
        self.assertEqual(self.request('DELETE','/jobs/../../models',{'Authorization':'Bearer '+server.TOKEN})[0],404)
    def test_cancel_terminates_only_the_owned_job_and_removes_its_files(self):
        identifier=str(uuid.uuid4())
        directory=tempfile.mkdtemp(prefix='transcription-test-')
        process=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],start_new_session=True)
        job={'process':process,'directory':directory,'created':0}
        with server.LOCK:
            server.JOBS[identifier]=job
        try:
            self.assertEqual(self.request('DELETE','/jobs/'+identifier,{'Authorization':'Bearer '+server.TOKEN}),(200,{'removed':True}))
            self.assertIsNotNone(process.poll())
            self.assertFalse(Path(directory).exists())
        finally:
            with server.LOCK:
                server.JOBS.pop(identifier,None)
            server.remove(job)
    def test_terminal_progress_waits_for_process_exit_and_a_complete_result(self):
        # No inference or timing assumptions: hold the worker in its exact
        # pre-exit window even after it has written the terminal progress file.
        for terminal_phase, returncode in [('ready', 0), ('failed', 1)]:
            with self.subTest(phase=terminal_phase), tempfile.TemporaryDirectory(prefix='media-terminal-fixture-') as path:
                identifier=str(uuid.uuid4())
                directory=Path(path)
                process=SimpleNamespace(returncode=None)
                process.poll=lambda: process.returncode
                job={'directory':path,'process':process,'created':time.monotonic()}
                with server.LOCK:
                    server.JOBS[identifier]=job
                auth={'Authorization':'Bearer '+server.TOKEN}
                try:
                    (directory/'progress.json').write_text(json.dumps({'phase':'transcribing'}))
                    self.assertEqual(self.request('GET','/jobs/'+identifier,auth),(200,{'state':'transcribing'}))
                    payload={'transcript':{'text':'synthetic speech'},'audio':None}
                    (directory/'result.json').write_text(json.dumps(payload))
                    (directory/'error.json').write_text(json.dumps({'code':'SYNTHETIC_FAILURE'}))
                    (directory/'progress.json').write_text(json.dumps({'phase':terminal_phase}))
                    self.assertEqual(self.request('GET','/jobs/'+identifier,auth),(200,{'state':'transcribing'}))
                    process.returncode=returncode
                    status,data=self.request('GET','/jobs/'+identifier,auth)
                    self.assertEqual(status,200)
                    if returncode==0:
                        self.assertEqual(data,{'state':'ready','result':payload['transcript'],'audio':None,'transcriptionError':None})
                    else:
                        self.assertEqual(data,{'state':'failed','error':'SYNTHETIC_FAILURE'})
                finally:
                    with server.LOCK:
                        server.JOBS.pop(identifier,None)

    def test_ready_progress_on_first_poll_cannot_report_a_result_before_exit(self):
        identifier=str(uuid.uuid4())
        with tempfile.TemporaryDirectory(prefix='media-first-poll-fixture-') as path:
            directory=Path(path)
            (directory/'progress.json').write_text(json.dumps({'phase':'ready'}))
            process=SimpleNamespace(poll=lambda:None)
            with server.LOCK:
                server.JOBS[identifier]={'directory':path,'process':process,'created':time.monotonic()}
            try:
                status,data=self.request('GET','/jobs/'+identifier,{'Authorization':'Bearer '+server.TOKEN})
                self.assertEqual(status,200)
                self.assertNotIn(data['state'],['ready','failed'])
            finally:
                with server.LOCK:
                    server.JOBS.pop(identifier,None)

    def test_extracts_and_downloads_real_audio_through_private_api(self):
        identifier=str(uuid.uuid4())
        auth={'Authorization':'Bearer '+server.TOKEN}
        with tempfile.TemporaryDirectory(prefix='media-api-fixture-') as path:
            video=Path(path)/'video.mp4'
            subprocess.run(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=64x64:r=10:d=1','-f','lavfi','-i','sine=frequency=440:duration=1','-t','1','-c:v','mpeg4','-c:a','aac',str(video)],check=True,timeout=30)
            self.assertEqual(self.request('POST','/jobs',{**auth,'X-Job-Id':identifier,'X-Media-Operation':'extract'},video.read_bytes())[0],202)
            try:
                deadline=time.monotonic()+30
                while time.monotonic()<deadline:
                    _,job=self.request('GET','/jobs/'+identifier,auth)
                    self.assertNotEqual(job['state'],'failed',job)
                    if job['state']=='ready':break
                    time.sleep(.1)
                else:self.fail('real audio extraction timed out')
                self.assertIsNone(job['result'])
                connection=http.client.HTTPConnection('127.0.0.1',self.http.server_port,timeout=5)
                connection.request('GET','/jobs/'+identifier+'/audio',headers=auth)
                response=connection.getresponse();data=response.read();connection.close()
                self.assertEqual(response.status,200)
                self.assertEqual(response.getheader('Content-Type'),'audio/mpeg')
                self.assertEqual(len(data),job['audio']['size'])
                directory=server.JOBS[identifier]['directory']
            finally:
                self.request('DELETE','/jobs/'+identifier,auth)
            self.assertNotIn(identifier,server.JOBS)
            self.assertFalse(Path(directory).exists())
if __name__=='__main__':unittest.main()
