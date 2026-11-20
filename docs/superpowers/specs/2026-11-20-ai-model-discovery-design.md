# AI provider model discovery

**Intent:** Staff should be able to connect a provider and choose from its reported models without already knowing a model ID.

## Approaches

- A static catalog is simple but goes stale and cannot establish what a key can see.
- Provider-reported discovery with a manual model fallback is the selected approach. It uses the provider's account-filtered list where available and distinguishes a public catalog from verified access.
- Testing every model with a generated prompt would cost money, hit quotas, and exceed the requested scope.

## Experience

1. In Clinic setup, choose a provider and enter a key where needed. **Validate & load models** does not require a model ID. Custom or keyless endpoints use **Load models**.
2. Search the reported models by name or ID, then select one. Keep manual model ID entry available, including if discovery is blocked by the browser, unsupported, or returns no models. Do not silently pick or save a model.
3. Show what the provider actually confirmed. A successful authenticated list means the key was accepted for discovery, not that any model is guaranteed to run, be free, or fit the account's limits. A public or unverified endpoint list is labeled **Provider catalog — access not verified**. Keyless Ollama reports installed models rather than key status.
4. Changing the provider, key, or endpoint invalidates the results; a late response cannot restore them. Turning AI off, clearing settings, or leaving the workspace also clears them.

## Constraints

- Browser-only. No new backend, proxy, dependencies, inference, prompts, patient data, or changes to the offline AI Clerk. Offline demo makes no provider requests.
- Only send credentials for an explicit user action to the selected endpoint. Built-in cloud keys go only to their official configured origins/paths. Use Custom for an alternate HTTPS endpoint with an explicitly entered key; do not send a key over plain HTTP. Do not follow redirects.
- Discovery never saves a key, model list, or provider response. Keep the existing explicit local **Save AI Settings** operation; no Firestore writes. Do not expose keys or raw provider errors in messages or logs.
- Test with fictional keys and intercepted API responses, not live provider calls.
