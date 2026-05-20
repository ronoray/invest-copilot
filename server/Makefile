.PHONY: test-upstox test-upstox-auth

# Run all Upstox unit tests
test-upstox:
	node --test tests/upstox-notifier.test.js tests/upstox-postback.test.js tests/upstox-token-guard.test.js

# Integration smoke: requires a running local server (npm start in another terminal)
# Posts sample notifier payload → asserts /health/upstox reports has_token: true
test-upstox-auth:
	node tests/smoke/upstox-auth-smoke.js
