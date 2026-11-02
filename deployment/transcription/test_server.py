import http.client
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import uuid
import threading
import unittest
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
if __name__=='__main__':unittest.main()
