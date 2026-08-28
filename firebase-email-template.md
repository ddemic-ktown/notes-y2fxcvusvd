# Firebase sign-in email — template to paste

The email everyone receives when you invite them (a user *or* a new company) is
Firebase's stock "email address sign-in" message. It says nothing about JobPilot,
nothing about who invited them, and nothing about a company — so it reads like a
stray login email and gets ignored or binned.

You can't fix that in the app; the text lives in your Firebase project. It's a
five-minute copy-and-paste.

## Where

1. https://console.firebase.google.com/project/note-aggregator
2. **Authentication** → **Templates** tab
3. Choose **Email address sign-in**
4. Click the pencil to edit, paste the text below, **Save**

## Sender name

Set this first — it's the single biggest difference. Change the sender name from
the default to **JobPilot**, so it arrives from a name rather than a project id.

## Subject

```
Sign in to JobPilot
```

## Message

Firebase substitutes `%LINK%` with the sign-in link. Keep it exactly as written —
the placeholder is case-sensitive.

```
Hello,

You've been invited to JobPilot. Click the link below to sign in — there's no
password to set up first.

%LINK%

The link works once and expires. If it's expired by the time you get to it, ask
whoever invited you to send another.

If you weren't expecting this, you can ignore this email — nothing happens
unless you click the link.
```

## Two things to know

**One template covers both.** Firebase has a single email-sign-in template, so
this same text goes to someone joining your company and to someone starting
their own. It can't name the company, because Firebase doesn't know it. That's
why the app shows you a hand-off message to send them separately after inviting
a new company.

**The link isn't the only way in.** The invite is matched by email address, so
they can also sign in with Google or a password using the invited address. Worth
knowing when someone can't find the email.

## Optional: stop it landing in spam

The email comes from a `firebaseapp.com` address by default, which spam filters
treat with suspicion. Under **Authentication → Templates → Customize domain**
you can send from your own domain instead. That needs DNS records adding and is
a bigger job than the template — worth it only if delivery turns out to be a
real problem.
