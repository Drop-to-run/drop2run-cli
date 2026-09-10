# Security

## Reporting

Email **security@dropto.run**, or open a private advisory through GitHub's "Report a vulnerability"
button on the Security tab. Please do not open a public issue for anything exploitable.

Include what you did, what happened, and what you expected. A proof of concept helps; a video is
rarely necessary. You will get a reply — if a week passes without one, assume the mail went astray
and send it again rather than assuming it was ignored.

Reports about a **site hosted on** dropto.run — phishing, malware, someone else's content — are a
different thing and go to abuse@dropto.run or [dropto.run/abuse](https://dropto.run/abuse). This
address is for flaws in the code.

## What is worth reporting here

This repository holds the two things that run on your own machine: the `drop2run` CLI and the
`@drop2run/mcp` server. The interesting surface is small and it is all about the credential:

- Anything that writes a token somewhere it should not be, or with permissions that let another
  user on the machine read it.
- Anything that sends a token to a host other than the API it was issued for.
- Anything that makes the CLI upload a file the user did not select — path traversal out of the
  chosen folder, symlinks followed off the tree, an ignore rule that fails open.
- Anything in the sign-in flow that lets a local process other than the one that started it
  complete the exchange.

Findings in the hosted service — the API, the edge router, the dashboard — are equally welcome at
the same address, even though the code for them is not in this repository.

## Supported versions

The latest published version of each package. There are no long-term support branches: fixes go out
as a new release rather than as a backport.
