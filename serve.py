#!/usr/bin/env python3
"""Локальный статический сервер для предпросмотра приложения.
Сам переходит в свою папку, чтобы не зависеть от рабочего каталога процесса."""
import http.server
import os
import socketserver

os.chdir(os.path.dirname(os.path.abspath(__file__)))
PORT = 8123

Handler = http.server.SimpleHTTPRequestHandler
with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"serving {os.getcwd()} at http://localhost:{PORT}")
    httpd.serve_forever()
