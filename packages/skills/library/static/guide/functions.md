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
- kit.retry(request, { tries }): kit.http, tried again after a 429, a 5xx or a failed connection.
- kit.run("service.function", input): runs another saved function and answers its result: a flow of functions, even across services.
- kit.state.get() and kit.state.set(value): what the function keeps between runs (the last item it saw, say), at most 64 KB; kept only when the run ends well.
- kit.log(...values): a line in the run's log, shown with its result.
- kit.sleep(ms): waits, at most 10 s.
- kit.b64.encode(text, { url }) and kit.b64.decode(text): base64 of UTF-8 text (there's no btoa or atob).

- input is the JSON the run was given; return JSON. Keep the answer to what the user needs (at most 64 KB as JSON): pick fields, count instead of listing.
- Throw an Error to fail; its message and line are shown.
- A run stops after 10 minutes (in a scheduled job, before the job's time runs out), after 200 requests and commands, and when it uses too much memory.
- A run the chat waited 40 s for goes on in the background: run answers with its run_id. Carry on; its end is shown at the top of a later library or run answer. run with run_id shows it, and stop: true stops it.
- Don't put a key, a token or a password in a function: kit adds them as it sends.
