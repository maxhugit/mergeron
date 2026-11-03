#!/usr/bin/env bash
# Synthetic speech only. No accounts, no ports, no outbound network, no Docker socket.
set -euo pipefail
image=${1:?image reference required}
name="mergeron-transcription-smoke-${RANDOM}-${RANDOM}"
fixture=$(mktemp -d)
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$fixture"; }
trap cleanup EXIT
espeak-ng -v en-us -s 140 -w "$fixture/english.wav" 'Hello. This is a local transcription test. The meeting starts tomorrow morning.'
espeak-ng -v fr-fr -s 140 -w "$fixture/french.wav" 'Bonjour. Ceci est un test de transcription en français. La réunion commence demain matin.'
ffmpeg -nostdin -v error -f lavfi -i color=c=blue:s=64x64:r=10 -i "$fixture/english.wav" -shortest -c:v mpeg4 -c:a aac "$fixture/video.mp4"
chmod 755 "$fixture"
chmod 644 "$fixture"/*.wav "$fixture/video.mp4"
docker run -d --name "$name" --network none --read-only --user 11003:11003 --cap-drop ALL --security-opt no-new-privileges:true --memory 6g --cpus 4 --pids-limit 128 --init --tmpfs /tmp:rw,nosuid,nodev,noexec,size=1g,mode=1777 --mount "type=bind,src=$fixture,dst=/fixtures,readonly" -e "TRANSCRIPTION_TOKEN=$(printf 'a%.0s' {1..64})" "$image" >/dev/null
# -i is required to pass the fixture driver over stdin.
docker exec -i "$name" python - <<'PY'
import hashlib, json, os, subprocess, time, urllib.request, urllib.error, uuid
import torch, torchcodec
from pyannote.audio import Pipeline
assert not torch.cuda.is_available()
base='http://127.0.0.1:8090'
def request(path,method='GET',data=None,extra=None):
    headers={'Authorization':'Bearer '+os.environ['TRANSCRIPTION_TOKEN'],**(extra or {})}
    with urllib.request.urlopen(urllib.request.Request(base+path,method=method,data=data,headers=headers),timeout=30) as response:
        return json.load(response)
for _ in range(30):
    try:
        if request('/healthz')['ready']:break
    except OSError:pass
    time.sleep(1)
else:raise AssertionError('worker health timeout')
try:urllib.request.urlopen(base+'/jobs/nope')
except urllib.error.HTTPError as error:assert error.code==401
else:raise AssertionError('unauthenticated job endpoint accepted')
for filename,language,word in [('english.wav','en','hello'),('french.wav','fr','bonjour')]:
    identifier=str(uuid.uuid4())
    with open('/fixtures/'+filename,'rb') as audio:request('/jobs','POST',audio.read(),{'X-Job-Id':identifier,'X-Media-Operation':'both' if language=='en' else 'transcribe'})
    deadline=time.monotonic()+240
    while time.monotonic()<deadline:
        job=request('/jobs/'+identifier)
        assert job['state']!='failed', job
        if job['state']=='ready':break
        time.sleep(1)
    else:raise AssertionError('real transcription timeout')
    result=job['result']
    assert result['language']==language,result
    assert word in result['text'].lower(),result
    assert result['segments'] and result['duration']>0
    assert result['diarization']['state']=='unavailable'
    if language=='en':
        with urllib.request.urlopen(urllib.request.Request(base+'/jobs/'+identifier+'/audio',headers={'Authorization':'Bearer '+os.environ['TRANSCRIPTION_TOKEN']}),timeout=30) as response:audio=response.read()
        assert hashlib.sha256(audio).hexdigest()==job['audio']['sha256']
    assert request('/jobs/'+identifier,'DELETE')['removed']
    print('Synthetic speech passed:',language)
identifier=str(uuid.uuid4())
with open('/fixtures/video.mp4','rb') as video:request('/jobs','POST',video.read(),{'X-Job-Id':identifier,'X-Media-Operation':'extract'})
deadline=time.monotonic()+60
while time.monotonic()<deadline:
    job=request('/jobs/'+identifier)
    assert job['state']!='failed',job
    if job['state']=='ready':break
    time.sleep(1)
else:raise AssertionError('video extraction timeout')
assert job['result'] is None
with urllib.request.urlopen(urllib.request.Request(base+'/jobs/'+identifier+'/audio',headers={'Authorization':'Bearer '+os.environ['TRANSCRIPTION_TOKEN']}),timeout=30) as response:audio=response.read()
assert len(audio)==job['audio']['size']
assert hashlib.sha256(audio).hexdigest()==job['audio']['sha256']
probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-protocol_whitelist','file,pipe','-show_streams','-of','json','-i','pipe:0'],input=audio,timeout=10))
assert len(probe['streams'])==1 and probe['streams'][0]['codec_name']=='mp3'
assert request('/jobs/'+identifier,'DELETE')['removed']
print('Synthetic video extraction passed')
PY
