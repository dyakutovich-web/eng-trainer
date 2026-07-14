#!/bin/bash
# Тест-раннер: движок + тесты в JavaScriptCore (node не требуется).
cd "$(dirname "$0")/.."
cat js/engine.js tests/engine.test.js > /tmp/evt_test_run.js
osascript -l JavaScript /tmp/evt_test_run.js
