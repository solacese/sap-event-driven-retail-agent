# Third-Party Software and Attribution

This demo ships and links third-party software. This document records notable
licenses and the obligations they place on this project. It is not legal advice;
consult counsel before external distribution.

## Avatar rendering engine - AGPL-3.0-only

The agent avatar ("Strobi") is rendered by the original open-source engine, used
as-published from npm. We do **not** vendor, fork, or reinterpret the source; the
demo consumes the packages directly so the animation is a faithful port of the
original web app at https://avatars.bible-strong.app/.

| Package | Version | License | Role |
| --- | --- | --- | --- |
| `@bible-strong/avatar-core` | 0.1.0 | AGPL-3.0-only | Procedural engine: geometry, scene graph, runtime, ambient motion, validators |
| `@bible-strong/avatar-react` | 0.1.0 | AGPL-3.0-only | React 19 renderer (`<Avatar>` component, imperative controller, stylesheet) |

- **Author / source:** Stephane Montlouis-Calixte - https://github.com/smontlouis/bible-strong-avatar-lab
- **Upstream demo:** https://avatars.bible-strong.app/
- **License text:** GNU Affero General Public License v3.0 - https://www.gnu.org/licenses/agpl-3.0.en.html

### What AGPL-3.0 requires

The AGPL is a strong copyleft license. Two obligations matter for this project:

1. **Network use is distribution.** Section 13 treats making the software
   available to users over a network (e.g. serving this dashboard) as conveying
   it. Users interacting with the deployed demo must be offered the
   corresponding source of the AGPL-covered components.
2. **Corresponding source and modifications.** If the AGPL components - or a work
   based on them - are conveyed or served, the complete corresponding source
   (including any modifications) must be made available under the AGPL, and the
   license and copyright notices preserved.

### How this project complies

- The packages are used **unmodified** and installed from npm; their source is
  publicly available at the upstream repository linked above.
- This project links to that upstream source and preserves the license notice
  here. No changes to the engine source have been made.
- The AGPL scope is limited to the avatar rendering path. The rest of this
  project (the Solace event-driven agent, gateway, and dashboard shell) is a
  separate work; the avatar packages are an aggregated dependency, not a
  derivative base of the whole application.

### Deployment note (SAP co-sell context)

If this demo is deployed as a hosted, network-facing service, the AGPL Section 13
source-offer obligation applies to the avatar components. Options:

- Keep the demo local / internal (the current mock and self-hosted modes), where
  network conveyance to third parties does not occur, **or**
- Provide a prominent link to the upstream source (already recorded here) from the
  running app if externally hosted, **or**
- Replace the avatar with a non-copyleft asset if AGPL obligations are unacceptable
  for a given distribution channel.

## Other dependencies

The remaining runtime dependencies are permissively licensed (MIT / Apache-2.0 /
ISC / BSD), including React and ReactDOM (MIT), Express (MIT), Helmet (MIT),
`solclientjs` (Solace, redistributable), and Zod (MIT). Run `npm ls --all` or a
license scanner (e.g. `license-checker`) for the full transitive list.
