A function is plain JavaScript that defines one async function, main. It runs in a small engine of its own: there is no require, no fetch, no files and no process, only its input and kit.

```js
async function main(input, kit) {
  const answer = await kit.http({ path: `/repos/${input.repo}/issues`, params: { state: "open" } });
  if (!answer.ok) throw new Error(`the API answered ${answer.status}`);
  return answer.body.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title }));
}
```

Save it with save, service, function { name, description, inputs, source } and test (inputs to run it with right away):

```json
{ "name": "list_issues", "description": "The open issues of a repository.", "inputs": { "repo": { "type": "string", "required": true, "about": "owner/name" } }, "source": "async function main(input, kit) { ... }" }
```

Then run it with run, name "github.list_issues", inputs { "repo": "owner/name" }.

What kit offers:
- kit.http({ method, path, url, params, headers, body, auth }): one request; answers { status, ok, headers, body, cut }, body parsed when it's JSON. path is relative to the toolkit's first base address; url reaches another of its hosts. params go in the query; an object body goes as JSON (or as a form, with a Content-Type header saying so). auth names one of the toolkit's keys, or false for none; the first goes by default. You can't set Authorization or Cookie: the key is added for you, outside the function.
- kit.ssh.exec({ target, command, stdin, timeout_s, max_bytes }): runs a command on one of the toolkit's targets, a machine the user registered (topic targets); answers { exit, signal, stdout, stderr, truncated, killed, remote_may_run, ms }.
- kit.ssh.put({ target, path, content, encoding, mode, append }) and kit.ssh.get({ target, path, offset, bytes, encoding }): write and read a file on a target, at most 1 MB a call (topic targets).
- kit.retry(request, { tries }): kit.http, tried again after a 429, a 5xx or a failed connection.
- kit.run("service.function", input): runs another saved function and answers its result: a flow of functions, even across services.
- kit.state.get() and kit.state.set(value): what the function keeps between runs (the last item it saw, say), at most 64 KB; kept only when the run ends well.
- kit.log(...values): a line in the run's log, shown with its result.
- kit.sleep(ms): waits, at most 10 s.
- kit.b64.encode(text, { url }) and kit.b64.decode(text): base64 of UTF-8 text (there's no btoa or atob).
- kit.crypto: what QuickJS can't do well, computed outside the function. Bytes go in as text (UTF-8) or { base64 }, and come out as hex, or as `as` says ("base64", "base64url"). Each input is at most 1 MB.
  - kit.crypto.sha256(data, { as }) and kit.crypto.sha512(data, { as }).
  - kit.crypto.random(n): n secure random bytes (at most 1024), as base64. kit.crypto.uuid(): a random UUID. (Math.random isn't secure.)
  - kit.crypto.ed25519.verify({ public, data, signature }): whether an Ed25519 signature (base64) of data checks with a public key (its 32 raw bytes, base64). kit.crypto takes no secret key: signing is kit.secret's.
  - kit.crypto.sshsig.verify({ signature, data, namespace, keys }): whether an SSH signature (the armored -----BEGIN SSH SIGNATURE----- block) signs data in namespace by one of keys ("ssh-ed25519 <base64>" lines); answers { valid: true, key } or { valid: false, reason }.
- kit.secret: signing with a key kept in the Vault, which the function names and never sees (topic secrets).
  - kit.secret.sign({ key, data }): answers { signature, public, namespace }, signature an SSH signature (as `ssh-keygen -Y sign` makes them) in the key's own namespace.
  - kit.secret.publicKey({ key }): answers { public, fingerprint, namespace }.

- input is the JSON the run was given; return JSON. Keep the answer to what the user needs (at most 64 KB as JSON): pick fields, count instead of listing.
- Throw an Error to fail; its message and line are shown.
- A run stops after 10 minutes (in a scheduled job, before the job's time runs out), after 200 requests and commands, when it uses too much memory, and when it computes for 2 s without awaiting a kit call: work through a big answer a page at a time, or await one between batches (kit.sleep(0) will do).
- A run the chat waited 40 s for goes on in the background: run answers with its run_id. Carry on; its end is shown at the top of a later library or run answer. run with run_id shows it, and stop: true stops it.
- Don't put a key, a token or a password in a function: kit adds them as it sends, and signs with a signing key by its name.
