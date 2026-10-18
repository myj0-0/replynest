"""Fail before staging/pushing secret-bearing files; findings never print values.

Reads local ignored configuration for known-secret comparison, never uploads it.
--staged scans the actual Git index; default scans upload-eligible worktree files.
This is a heuristic guard, not a claim that every possible secret format is known.
"""
import argparse,hashlib,json,pathlib,re,subprocess,sys
ROOT=pathlib.Path(__file__).resolve().parents[1]
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT)
def known_secrets():
 values=set()
 for path in [ROOT/'PW.md',ROOT/'.env',ROOT/'.env.local',ROOT/'deploy/production/chatwoot-admin.env']:
  if not path.is_file():continue
  text=path.read_text('utf-8',errors='replace')
  for line in text.splitlines():
   match=re.match(r'\s*(?:[-*]\s*)?([A-Za-z0-9_ .\-\u4e00-\u9fff]+)\s*[:=：]\s*([^\r\n]+)',line.replace('**',''))
   if match and re.search(r'secret|password|passwd|private|token|access.?key|api.?key|encodingaeskey|密码|密钥',match[1],re.I):
    raw_value=match[2].strip()
    quoted=re.match(r'[\"\x27`]([^\"\x27`]+)[\"\x27`]',raw_value)
    value=quoted[1] if quoted else raw_value.split(' #',1)[0].strip().strip('\"\x27` ')
    if len(value)>=8 and not any(s in value.lower() for s in ['example','placeholder','changeme','replace','your-','${','process.env','http://','https://']):values.add(value.encode())
  for m in re.finditer(r'(?m)^[A-Za-z0-9+/]{80,}={0,2}$',text):values.add(m[0].encode())
 return values
PATTERNS={
 'private_key':rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{80,}?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
 'github_token':rb'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,})',
 'cloud_access_key':rb'(?<![A-Z0-9])(?:AKIA|ASIA|LTAI)[A-Za-z0-9]{16,30}(?![A-Za-z0-9])',
 'provider_key':rb'(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{24,}',
 'credential_url':rb'(?:postgres(?:ql)?|mysql|redis|amqps?)://[^\s:\x22\x27]+:[^\s@\x22\x27]{8,}@',
}
def main(staged):
 paths=[p.decode('utf-8') for p in git('diff','--cached','--name-only','--diff-filter=ACM','-z').split(b'\0') if p] if staged else [p.decode('utf-8') for p in git('ls-files','-z','--cached','--others','--exclude-standard').split(b'\0') if p]
 secrets=known_secrets();findings=[];scanned=0;large=[]
 for name in dict.fromkeys(paths):
  path=ROOT/name
  if not staged and not path.is_file():continue
  raw=git('show',':'+name) if staged else path.read_bytes();scanned+=1
  if len(raw)>50*1024*1024:large.append(name)
  if re.search(r'(^|/)(?:PW\.md|\.env(?:\.(?!example$).+)?|[^/]*\.private\.[^/]*|[^/]*\.(?:pem|key|p12|pfx|dump))$',name):findings.append({'file':name,'kind':'forbidden_path','line':0})
  for value in secrets:
   offset=raw.find(value)
   if offset>=0:findings.append({'file':name,'kind':'known_local_secret','line':raw[:offset].count(b'\n')+1})
  for kind,pattern in PATTERNS.items():
   for match in re.finditer(pattern,raw):
    # Expressions are not embedded credentials. These two exact public fixture
    # passwords are restricted to the reviewed isolated test files below.
    if kind=='credential_url':
     password=match[0].split(b'://',1)[1].split(b':',1)[1].rsplit(b'@',1)[0]
     if b'${' in password or (password.startswith(b'{') and password.endswith(b'}')):continue
     fixtures={
      'scripts/automatic-wechat-claim-acceptance.mjs':b'isolated-wechat-claim-only',
      'scripts/test-personalization-db.py':b'isolated-runtime-password',
      # Reviewed disposable loopback container; not a production credential.
      'scripts/prove-wechat-media-owner.py':b'synthetic-fixture-only'}
     if fixtures.get(name)==password:continue
    findings.append({'file':name,'kind':kind,'line':raw[:match.start()].count(b'\n')+1})
 print(json.dumps({'mode':'index' if staged else 'worktree','scanned':scanned,'findings':findings,'oversized_files':large},ensure_ascii=False,indent=2))
 return 1 if findings or large else 0
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--staged',action='store_true');sys.exit(main(p.parse_args().staged))
