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
chmod 755 "$fixture"
chmod 644 "$fixture"/*.wav
docker run -d --name "$name" --network none --read-only --user 11003:11003 --cap-drop ALL --security-opt no-new-privileges:true --memory 6g --cpus 2 --pids-limit 128 --init --tmpfs /tmp:rw,nosuid,nodev,noexec,size=1g,mode=1777 --mount "type=bind,src=$fixture,dst=/fixtures,readonly" -e "TRANSCRIPTION_TOKEN=$(printf 'a%.0s' {1..64})" "$image" >/dev/null
# -i is required to pass the fixture driver over stdin.
docker exec -i "$name" python - <<'PY'
import json, os, time, urllib.request, urllib.error, uuid
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
    with open('/fixtures/'+filename,'rb') as audio:request('/jobs','POST',audio.read(),{'X-Job-Id':identifier})
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
    assert request('/jobs/'+identifier,'DELETE')['removed']
    print('Synthetic speech passed:',language)
PY
