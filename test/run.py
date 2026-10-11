"""All checks in one go: the capture tests in Chromium, then the main thread on that capture.

    python test/run.py

Needs Playwright for Python (pip install playwright && playwright install chromium) and Node 18+.
Build code.js first (npm run build).
"""
import functools
import http.server
import os
import socketserver
import subprocess
import sys
import tempfile
import threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def browser_check(page, path):
    page.goto(path)
    page.wait_for_function("/PASSED|FAILED|threw/.test(document.getElementById('out').textContent)", timeout=400000)
    text = page.locator('#out').text_content()
    print(text + '\n')
    return 'FAILED' not in text and 'threw' not in text


def main():
    srv = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT))
    base = 'http://127.0.0.1:%d/' % srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    ok = True
    capture = os.path.join(tempfile.gettempdir(), 'html-figma-capture.json')
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        print('== test/check.html (static capture)')
        ok &= browser_check(page, base + 'test/check.html')
        print('== test/motion-check.html (animations, hover, clicks)')
        ok &= browser_check(page, base + 'test/motion-check.html')
        with open(capture, 'w', encoding='utf-8') as f:
            f.write(page.evaluate('JSON.stringify(window.__result)'))
        browser.close()
    srv.shutdown()
    print('== test/main-check.mjs (main thread, stand-in Figma API)')
    ok &= subprocess.run(['node', os.path.join(ROOT, 'test', 'main-check.mjs'), capture]).returncode == 0
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
