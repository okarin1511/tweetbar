// Drafts tweets from what you actually shipped: new git commits in the repos you
// allowlisted plus your commits on GitHub, turned into tweets in your voice by `claude -p` (runs on your
// Claude Code login, no API key). Drafts are only ever suggestions; nothing here
// posts anything.
const { execFile, spawn } = require('child_process')
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')

const MODEL = 'sonnet'
const CLAUDE_TIMEOUT_MS = 180000

const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { maxBuffer: 4e6 }, (err, out) => (err ? reject(err) : resolve(out.trim()))))

// GUI-launched apps don't get your shell PATH, so ask a login shell once per tool.
const bins = {}
async function findBin(name) {
  if (!bins[name]) bins[name] = await run('/bin/zsh', ['-lc', `command -v ${name}`]).catch(() => '')
  if (!bins[name]) throw new Error(`\`${name}\` CLI not found on your PATH`)
  return bins[name]
}

async function askClaude(prompt, cwd) {
  const bin = await findBin('claude')
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['-p', '--model', MODEL, '--no-session-persistence'], { cwd })
    let out = '', err = ''
    const timer = setTimeout(() => p.kill(), CLAUDE_TIMEOUT_MS)
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('error', e => { clearTimeout(timer); reject(e) })
    p.on('close', code => {
      clearTimeout(timer)
      code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `claude exited with ${code}`))
    })
    p.stdin.end(prompt)
  })
}

// For each repo: its HEAD and your commits since the last scan (last 24h on the
// first scan, or when forced).
async function readActivity(repos, seen) {
  const results = await Promise.all(repos.map(async repo => {
    try {
      const head = await run('git', ['-C', repo, 'rev-parse', 'HEAD'])
      if (seen[repo] === head) return null
      const email = await run('git', ['-C', repo, 'config', 'user.email']).catch(() => '')
      const args = ['-C', repo, 'log', '--no-merges', '-n', '30', '--pretty=format:- %s%n%b', '--shortstat']
      if (email) args.push(`--author=${email}`)
      args.push(seen[repo] ? `${seen[repo]}..HEAD` : '--since=24 hours ago')
      const log = await run('git', args).catch(() => '')
      return { repo, name: path.basename(repo), head, log: log.slice(0, 5000) }
    } catch {
      return null // not a git repo, or no commits yet
    }
  }))
  return results.filter(Boolean)
}

// Your commits on GitHub since `since`, from repos owned by your personal account
// (public and private). Org repos are left out on purpose: that's usually your
// employer's code. GitHub search only indexes default branches. One request,
// capped at 50 commits. Repos named in `skip` are already read locally.
let ghLogin = null
async function readGithub(since, skip) {
  const gh = await findBin('gh')
  if (!ghLogin) ghLogin = await run(gh, ['api', 'user', '--jq', '.login'])
  const q = `author:${ghLogin} user:${ghLogin} merge:false committer-date:>${since}`
  const out = await run(gh, ['api', '-X', 'GET', 'search/commits', '-f', `q=${q}`, '-f', 'sort=committer-date', '-f', 'per_page=50'])
  const items = JSON.parse(out).items || []
  const byRepo = new Map()
  for (const it of items) {
    const name = it.repository.name
    if (!skip.includes(name)) byRepo.set(name, [...(byRepo.get(name) || []), `- ${it.commit.message.trim()}`])
  }
  const latest = items.map(it => isoSeconds(new Date(it.commit.committer.date))).reduce((a, b) => (b > a ? b : a), since)
  return { latest, activity: [...byRepo].map(([name, lines]) => ({ name, log: lines.join('\n').slice(0, 5000) })) }
}

const isoSeconds = d => d.toISOString().replace(/\.\d+Z$/, 'Z')

function buildPrompt({ handle, pastTweets, activity }) {
  const voice = pastTweets.length
    ? pastTweets.map(t => `<tweet>${t}</tweet>`).join('\n')
    : '(no past tweets yet: write casual, lowercase-leaning, first person)'
  const work = activity.map(a => `## ${a.name}\n${a.log}`).join('\n\n')
  return `You draft build-in-public tweets for ${handle ? '@' + handle : 'a developer'}.

Here is what they shipped recently (their own git commits, per project):

${work}

Here are some of their past tweets, for voice only:
${voice}

Write 1 or 2 tweet drafts about this work. Rules:
- Each under 260 characters. First person. Sound like the past tweets, not like marketing.
- Be concrete: name the actual thing built, the bug hit, or the lesson learned. A specific detail beats a summary.
- No hashtags. No "excited to announce". No emojis unless the past tweets use them. No thread numbering.
- Never mention employers, clients, customers, internal systems, credentials, or anything that reads as confidential.
- If the work is too trivial to be worth a tweet (typos, formatting, version bumps), write nothing.

Output each draft wrapped in <draft></draft> tags and nothing else.`
}

const parseDrafts = out => [...out.matchAll(/<draft>([\s\S]*?)<\/draft>/g)]
  .map(m => m[1].trim())
  .filter(t => t && [...t].length <= 280)

function createDrafter({ dir, settings, getContext, onChange }) {
  const file = path.join(dir, 'drafts.json')
  const list = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return [] } }
  const save = drafts => { try { fs.writeFileSync(file, JSON.stringify(drafts)) } catch {} onChange(drafts) }
  const make = (text, source) => ({ id: crypto.randomUUID(), text, source, at: new Date().toISOString() })
  let busy = null
  let github = { login: null, error: null }

  // Returns how many drafts were added. `force` re-reads the last 24h even if
  // those commits were already drafted from, replacing those repos' old drafts
  // with fresh options instead of piling up near-duplicates.
  function scan({ force = false } = {}) {
    if (busy) return busy
    busy = (async () => {
      const { draftRepos = [], seen = {}, githubOn = true, githubSince } = settings.read()
      const all = await readActivity(draftRepos, force ? {} : seen)
      // GitHub is optional (teammates may not have `gh`), so a failure there is
      // recorded for the sources panel instead of failing the whole scan.
      const since = force || !githubSince ? isoSeconds(new Date(Date.now() - 24 * 3600e3)) : githubSince
      const gh = githubOn
        ? await readGithub(since, draftRepos.map(r => path.basename(r)))
          .then(r => { github = { login: ghLogin, error: null }; return r }, err => { github = { login: ghLogin, error: err.message }; return null })
        : null
      const markSeen = () => settings.write({
        seen: { ...seen, ...Object.fromEntries(all.map(a => [a.repo, a.head])) },
        ...(gh && { githubSince: gh.latest > (githubSince || '') ? gh.latest : githubSince }),
      })
      const activity = [...all.filter(a => a.log), ...(gh ? gh.activity : [])]
      if (!activity.length) { markSeen(); return 0 }
      const out = await askClaude(buildPrompt({ ...getContext(), activity }), dir)
      const added = parseDrafts(out).map(t => make(t, activity.map(a => a.name).join(', ')))
      markSeen()
      const keep = force ? list().filter(d => !activity.some(a => d.source.split(', ').includes(a.name))) : list()
      if (added.length) save([...keep, ...added])
      return added.length
    })().finally(() => { busy = null })
    return busy
  }

  return {
    list,
    scan,
    add: (text, source = 'agent') => save([...list(), make(String(text).trim(), source)]),
    remove: id => save(list().filter(d => d.id !== id)),
    get: id => list().find(d => d.id === id),
    githubStatus: () => ({ on: settings.read().githubOn !== false, ...github }),
  }
}

module.exports = { createDrafter }
