# tweetbar

Post to X from a hotkey, without the paid X API. tweetbar drives the Google Chrome you're already signed in to, shows your own tweets as a build log, and drafts tweets from your git commits.

## Install (macOS, Apple Silicon or Intel)

1. Open `tweetbar-<version>-universal.dmg` and drag **tweetbar** into Applications.
2. The app isn't notarized by Apple, so the first launch is blocked. Run this once in Terminal:
   ```sh
   xattr -dr com.apple.quarantine /Applications/tweetbar.app
   ```
   Or try to open it, then go to System Settings → Privacy & Security and click **Open Anyway**.
3. In Chrome, in the profile that's signed in to X: **View → Developer → Allow JavaScript from Apple Events**. This is a per-profile setting.
4. Open tweetbar. When macOS asks whether tweetbar can control Google Chrome, click **Allow**.
5. Pick the Chrome window that's signed in to X. tweetbar keeps one background tab in that window and reuses it.

## Use

- **⌘⇧X** anywhere opens the quick bar. Type, then press ⌘↵ to post.
- The main window shows your tweets, streak, and a composer.
- **profile** switches to a different Chrome window or profile.

## Drafts from your work (optional)

- **sources**: add git repos you want tweets drafted from. The list starts empty.
- **draft from my work**: runs a pass on demand. The app also checks hourly for new commits.
- Drafts appear as ghost entries at the end of the log. Press ↵ to post, `e` to edit, `x` to dismiss. Nothing posts without you.
- Requires the [Claude Code](https://claude.com/claude-code) CLI (`claude`) installed and logged in. It uses your Claude login, not an API key.
- **Only add personal or open-source repos.** Commit messages are sent to Claude to write the drafts, and the drafts are meant to be posted publicly. Never add company repos.

## For agents

tweetbar listens on `127.0.0.1:4777`:

```sh
curl localhost:4777/tweets                                   # your recent tweets
curl -XPOST localhost:4777/draft -H 'Content-Type: application/json' \
  -d '{"text":"...","source":"my-agent"}'                    # add a draft for you to approve
curl -XPOST localhost:4777/tweet -H 'Content-Type: application/json' \
  -d '{"text":"..."}'                                        # post immediately
```

## Build from source

```sh
npm install
npm start          # run in dev
npm run dist       # build dist/tweetbar-<version>-universal.dmg and .zip
```
