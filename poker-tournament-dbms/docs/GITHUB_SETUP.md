# Publishing the project to GitHub

> Requirement 15: *"Each team should maintain the project source code using
> Git/GitHub. Commits should demonstrate individual contributions of team
> members. The repository should contain a suitable README with setup and
> execution instructions."*

Three things are being assessed: that the repository exists and is
organised, that **both** members' commits are visible, and that the README
tells someone how to run it. This guide covers all three.

---

## Before you start: check nothing secret is staged

```bash
cd poker-tournament-dbms
cat .gitignore | head -20
```

`.gitignore` already excludes `node_modules/`, `.next/`, `.env` and
`.env.local`. Confirm your real credentials are not about to be committed:

```bash
git status --porcelain --ignored | grep -E "\.env"
```

`.env.local` should appear as ignored. **`.env.example` is meant to be
committed** — it is the template, and it contains no real values.

---

## 1. Set your Git identity

Each member does this on their own machine, with the e-mail registered on
their GitHub account. Without it, commits are not attributed and the rubric
item is lost.

```bash
git config --global user.name  "Your Full Name"
git config --global user.email "your.github.email@example.com"
```

Check:

```bash
git config user.name && git config user.email
```

---

## 2. Create the repository on GitHub

1. Go to <https://github.com/new>
2. **Repository name:** `poker-tournament-dbms`
3. **Description:** `Poker Tournament Management and Analysis System — PostgreSQL + pgvector + Next.js (DBMS Level 3 Mini-Project)`
4. Choose **Private** (switch to public after evaluation if you wish)
5. **Do not** tick "Add a README", "Add .gitignore" or "Choose a license" —
   the project already has them, and pre-adding files causes a merge
   conflict on your first push
6. Click **Create repository**

---

## 3. Initialise and push

```bash
cd poker-tournament-dbms

git init
git branch -M main

git add .
git status                      # review the list before committing

git commit -m "Initial commit: schema, application, docs"

git remote add origin https://github.com/<your-username>/poker-tournament-dbms.git
git push -u origin main
```

If prompted for a password, GitHub wants a **personal access token**, not
your account password:
Settings → Developer settings → Personal access tokens → Tokens (classic) →
Generate new token → tick `repo` → copy it and use it as the password.

Alternatively use the GitHub CLI, which handles authentication for you:

```bash
gh auth login
gh repo create poker-tournament-dbms --private --source=. --push
```

---

## 4. Add your partner as a collaborator

On GitHub: **Settings → Collaborators → Add people** → their username →
pick **Write** access.

They then clone and work normally:

```bash
git clone https://github.com/<your-username>/poker-tournament-dbms.git
cd poker-tournament-dbms
npm install
cp .env.example .env.local      # their own local credentials
npm run db:reset
```

---

## 5. Make both members' contributions visible

This is the part the rubric actually checks. One giant commit from one
account scores badly however good the code is.

### Commit in topical units

```bash
git add db/01_schema.sql
git commit -m "feat(db): weak entities for blind structure and payout ladder"

git add db/05_procedures.sql
git commit -m "feat(proc): sp_register_player — atomic entry, payment, seat, snapshot"

git add lib/embedding.js
git commit -m "feat(vector): 256-d feature-hashing embedding with poker concept lexicon"
```

A readable convention, used throughout this project's own history:

| Prefix | For |
|---|---|
| `feat(db)` | New schema objects |
| `feat(proc)` | Procedures and functions |
| `feat(api)` | Route handlers |
| `feat(ui)` | Pages and components |
| `feat(vector)` | Embedding and search |
| `fix` | Corrections |
| `test` | Test cases |
| `docs` | Documentation |
| `refactor` | Restructuring without behaviour change |

### Use branches for larger pieces

```bash
git checkout -b feature/semantic-search
# … work, commit …
git push -u origin feature/semantic-search
```

Then open a pull request on GitHub and have the other member review and
merge it. The PR history is strong evidence of collaboration.

### Verify the split before submitting

```bash
git shortlog -sne
```

```
    24  Member A  <a@example.com>
    21  Member B  <b@example.com>
```

Roughly even is what you want. If one name dominates, the other member
should take ownership of some remaining work — documentation, tests, or a
feature — and commit it themselves.

```bash
git log --oneline --graph --all | head -30    # visual history
```

---

## 6. Finish the repository presentation

### Fill in the team names

`docs/INDIVIDUAL_CONTRIBUTIONS.md` has placeholders for both names and
SRNs. Fill them in and commit:

```bash
git add docs/INDIVIDUAL_CONTRIBUTIONS.md
git commit -m "docs: team details and responsibility split"
```

### Update the clone URL in the README

`README.md` and `HowToRun.md` reference
`https://github.com/<your-username>/poker-tournament-dbms.git`. Replace the
placeholder with your real URL.

### Add topics

On the repository page, click the gear beside **About** and add topics:
`dbms`, `postgresql`, `pgvector`, `nextjs`, `vector-search`,
`database-design`. Set the description too — it is the first thing an
evaluator sees.

### Tag the submission

```bash
git tag -a v1.0 -m "Final submission — DBMS Level 3 mini-project"
git push origin v1.0
```

A tag gives the evaluator an unambiguous commit to assess, even if you keep
working afterwards.

---

## 7. Final checklist

- [ ] Repository created and pushed to `main`
- [ ] `.env.local` is **not** in the repository (`git ls-files | grep env`
      should show only `.env.example`)
- [ ] `node_modules/` and `.next/` are not committed
- [ ] `README.md` renders correctly on GitHub, with screenshots visible
- [ ] `HowToRun.md` present and the clone URL updated
- [ ] Both members appear in `git shortlog -sne`
- [ ] Team names filled into `docs/INDIVIDUAL_CONTRIBUTIONS.md`
- [ ] `docs/er-diagram.png` and `docs/screenshots/` are committed
- [ ] Partner added as a collaborator
- [ ] Submission tagged `v1.0`
- [ ] Repository link submitted as the course requires

---

## Common problems

**`remote: Permission to … denied`**
Wrong account, or a token without `repo` scope. Regenerate the token with
`repo` ticked.

**`Updates were rejected because the remote contains work that you do not have locally`**
You initialised the GitHub repository with a README. Either start over
without it, or:

```bash
git pull --rebase origin main
git push -u origin main
```

**Accidentally committed `.env.local`**
Remove it from tracking and **change the password**, because it is now in
the history:

```bash
git rm --cached .env.local
git commit -m "fix: remove environment file from version control"
git push
```

For a complete scrub of the history, use
[`git filter-repo`](https://github.com/newren/git-filter-repo) — but
rotating the credential is the step that actually matters.

**Repository is large**
Check what is being committed:

```bash
git count-objects -vH
du -sh docs/screenshots
```

The screenshots are a few megabytes in total, which is fine. If
`node_modules/` was committed by mistake:

```bash
git rm -r --cached node_modules
git commit -m "fix: untrack node_modules"
```

**Screenshots do not appear in the README on GitHub**
Paths must be relative and the files must be committed:

```bash
git ls-files docs/screenshots | head
```
