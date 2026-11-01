import asyncio, importlib.util, io, json, os, sys, types, unittest
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('catalog_worker',Path(__file__).parents[1]/'src/app-catalog/fetch.py')
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)

class Page:
 def __init__(self,pages):self.pages=pages;self.index=-1;self.headers=[];self.urls=[]
 async def route(self,_pattern,handler):self.handler=handler
 async def goto(self,url,**_):
  self.url=url;self.urls.append(url);self.index+=1
  for destination in [url,'https://challenges.cloudflare.com/script']:
   page=self
   class Request:
    async def all_headers(self):return {'authorization':'old','chatgpt-account-id':'old','oai-product-sku':'old'}
   request=Request();request.url=destination
   class Route:
    async def continue_(self,headers):page.headers.append((destination,headers))
   route=Route();route.request=request;await self.handler(route)
 def locator(self,_selector):return self
 async def inner_text(self,**_):return json.dumps(self.pages[self.index])
class Browser:
 def __init__(self,page,seen):self.page=page;self.seen=seen
 async def __aenter__(self):return self
 async def __aexit__(self,*_):return False
 async def new_context(self,**kwargs):self.seen['context']=kwargs;return self
 async def new_page(self):return self.page

class WorkerTest(unittest.TestCase):
 def execute(self,pages,success=True):
  page=Page(pages);seen={};credentials={'accessToken':'private-token','accountId':'account'};output=io.StringIO()
  invisible=types.ModuleType('invisible_playwright.async_api')
  def browser(**kwargs):seen['browser']=kwargs;return Browser(page,seen)
  invisible.InvisiblePlaywright=browser
  challenge=types.ModuleType('src.challenge')
  async def no_challenge(_):return False
  async def solve(*_):raise AssertionError('unexpected challenge')
  challenge.challenge_present=no_challenge;challenge.solve_challenge=solve
  utils=types.ModuleType('src.utils');utils.TimeoutTimer=lambda **kwargs:kwargs
  with patch.dict(sys.modules,{'invisible_playwright.async_api':invisible,'src.challenge':challenge,'src.utils':utils}),patch.dict(os.environ,{'PROXY_SERVER':'http://reviewed-proxy:3128'}),patch.object(worker.os,'_exit',side_effect=SystemExit),patch('sys.stdout',output):
   if success:
    with self.assertRaises(SystemExit):asyncio.run(worker.fetch(credentials))
   else:
    with self.assertRaises((ValueError,TypeError)):asyncio.run(worker.fetch(credentials))
  return page,seen,output.getvalue(),credentials
 def test_pagination_and_credential_scope_with_tls_verification(self):
  page,seen,output,credentials=self.execute([{'apps':[{'id':'a','name':'A'}],'next_token':'next'},{'apps':[{'id':'b','name':'B'}],'next_token':None}])
  self.assertEqual(len(json.loads(output)['apps']),2);self.assertEqual(credentials,{})
  self.assertIn('token=next',page.urls[1]);self.assertEqual(seen['context'],{'ignore_https_errors':False})
  for destination,headers in page.headers:
   if destination.startswith('https://chatgpt.com/backend-api/connectors/directory/list'):
    self.assertEqual(headers['authorization'],'Bearer private-token')
   else:self.assertNotIn('authorization',headers);self.assertNotIn('chatgpt-account-id',headers)
 def test_refuses_invalid_empty_catalog(self):self.execute([{'apps':[]}],success=False)
 def test_refuses_repeated_pagination_tokens(self):self.execute([{'apps':[{'id':'a','name':'A'}],'next_token':'again'},{'apps':[{'id':'b','name':'B'}],'next_token':'again'}],success=False)

if __name__=='__main__':unittest.main()
