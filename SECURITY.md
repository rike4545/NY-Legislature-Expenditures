# Security

This is a static site: GitHub Pages serves HTML, CSS, JavaScript and JSON files, and there is no server, database, login or form that stores anything.

## Reporting a problem

Please report security issues privately through GitHub's **Report a vulnerability** button on this repository's Security tab rather than in a public issue.

## How the site is protected

- **Content Security Policy.** The page only runs its own script, loads its own styles, fonts and data, and talks to one outside service: the NYS ITS geocoder used by Find yours (`gisservices.its.ny.gov`). No ads, trackers, analytics or third-party fonts.
- **Escaping.** Everything from the data files is escaped before it reaches the page, and links built from data only allow web, mail and in-page addresses.
- **Privacy.** An address typed into Find yours is sent to the state's geocoder to place it on the map; the site doesn't store or log it. The only thing kept in the browser is the light/dark theme choice.
- **No individual donor names.** Campaign finance pages show totals and organizations, never individual donors.
- **Secrets.** The Open Legislation API key lives only in the repository secret `NYSENATE_API_KEY`, used by one step of the weekly refresh. It is never written to the repository or the site.
- **Workflows.** Every GitHub Action is pinned to a full commit SHA (Dependabot proposes updates), each workflow asks for the least permission it needs, and workflow inputs are validated before use. CodeQL scans the JavaScript, Python and workflows weekly and on every push.
