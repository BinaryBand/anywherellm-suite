Worked examples of functions, to read with guide and snippet, then adapt to the service's own API. Don't save one as it is: the paths, fields and paging are the example's, not the service's.

- `cursor-pagination`: follows a next cursor until there's enough, without fetching every page.
- `ntfy-channel`: an ntfy channel: reads its inbox topics (a poll, nothing taken off the server) and posts to the topics it may, under ntfy's size limit; optionally signs through a channel function (kit.run, like sshsig-channel) and frames each message with a hash line. Its NTFY is the example's: put in the deployment's own, and change nothing else.
- `sshsig-channel`: a signed channel, messages signed with SSH signatures: stamps and signs a message to a peer with a signing key (kit.secret.sign), and checks one a peer signed (kit.crypto.sshsig.verify). Its CHANNEL is the example's: put in the channel's own.
