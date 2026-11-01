"""Byparr browser job in its permanent managed container. Credentials arrive only on stdin; stdout is metadata."""
import asyncio
import json
import logging
import os
import sys
from urllib.parse import urlencode, urlsplit

logging.disable(logging.CRITICAL)
MAX_APPS = 20000
MAX_BYTES = 32 * 1024 * 1024
BASE = 'https://chatgpt.com/backend-api/connectors/directory/list'

async def fetch(credentials):
    from invisible_playwright.async_api import InvisiblePlaywright
    from src.challenge import solve_challenge, challenge_present
    from src.utils import TimeoutTimer
    proxy = os.environ['PROXY_SERVER']
    async with InvisiblePlaywright(
        headless=True, humanize=True, proxy={'server': proxy},
        timezone=os.environ.get('TZ', 'UTC'), locale=os.environ.get('BROWSER_LOCALE', 'en-US'),
        extra_prefs={'devtools.jsonview.enabled': False},
    ) as browser:
        context = await browser.new_context(ignore_https_errors=False)
        page = await context.new_page()
        target = BASE + '?external_logos=true'
        async def route_request(route):
            headers = await route.request.all_headers()
            for key in ['authorization', 'chatgpt-account-id', 'oai-product-sku']:
                headers.pop(key, None)
            # Never forward account credentials to challenge scripts or redirects.
            if route.request.url == target:
                headers.update({'authorization': 'Bearer ' + credentials['accessToken'],
                                'chatgpt-account-id': credentials['accountId'],
                                'oai-product-sku': 'codex'})
            await route.continue_(headers=headers)
        await page.route('**/*', route_request)
        apps, seen, tokens = [], set(), set()
        for _ in range(20):
            await page.goto(target, wait_until='domcontentloaded', timeout=60000)
            if await challenge_present(page):
                await solve_challenge(page, TimeoutTimer(duration=60))
            parsed_url = urlsplit(page.url)
            if parsed_url.scheme != 'https' or parsed_url.netloc != 'chatgpt.com' or parsed_url.path != urlsplit(BASE).path:
                raise ValueError('CATALOG_ORIGIN')
            body = await page.locator('body').inner_text(timeout=5000)
            if len(body.encode()) > MAX_BYTES:
                raise ValueError('CATALOG_SIZE')
            data = json.loads(body)
            if not isinstance(data, dict) or not isinstance(data.get('apps'), list) or not data['apps']:
                raise ValueError('CATALOG_RESPONSE')
            for app in data['apps']:
                if not isinstance(app, dict) or not isinstance(app.get('id'), str) or not isinstance(app.get('name'), str):
                    raise ValueError('CATALOG_RESPONSE')
                if app['id'] not in seen:
                    apps.append(app)
                    seen.add(app['id'])
                if len(apps) > MAX_APPS:
                    raise ValueError('CATALOG_SIZE')
            token = data.get('next_token', data.get('nextToken'))
            if not token:
                result = {'apps': apps}
                encoded = json.dumps(result, separators=(',', ':'))
                if len(encoded.encode()) > MAX_BYTES:
                    raise ValueError('CATALOG_SIZE')
                # The Manager restarts the same container to clear the browser tree.
                # Do not wait for the upstream browser shutdown which can hang.
                sys.stdout.write(encoded + '\n')
                sys.stdout.flush()
                credentials.clear()
                os._exit(0)
            if not isinstance(token, str) or len(token) > 8192 or token in tokens:
                raise ValueError('CATALOG_PAGINATION')
            tokens.add(token)
            target = BASE + '?' + urlencode({'external_logos': 'true', 'token': token})
        raise ValueError('CATALOG_PAGINATION')

def main():
    try:
        credentials = json.loads(sys.stdin.readline(16385))
        if not all(isinstance(credentials.get(k), str) and 0 < len(credentials[k]) < 12000 for k in ['accessToken', 'accountId']):
            raise ValueError('CATALOG_AUTH')
        asyncio.run(asyncio.wait_for(fetch(credentials), timeout=140))
    except BaseException:
        # No upstream body, exception text, cookie or credential is ever printed.
        sys.stdout.write('{"error":"CATALOG_DOWNLOAD_FAILED"}\n')
        sys.stdout.flush()
        os._exit(1)

if __name__ == "__main__":
    main()
