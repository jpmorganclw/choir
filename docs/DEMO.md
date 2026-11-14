# Demo video and demo post

The film is [video/choir-demo.mp4](../video/choir-demo.mp4): 88 seconds, 1920×1080, 30 fps,
H.264 and AAC, loudness -16 LUFS. Every action in it is a real call to the compiled contracts,
run on the practice chain, and the badge in the corner says so. A footer says that the people are
fictional and that the voices are AI-generated.

## Script

The spoken words are in [tools/video/script.json](../tools/video/script.json).

**1. The problem** (three drawn scenes, before the app appears)

- **Asha:** For two years, I ran our community's account. One login. Mine.
- **Asha:** I could post anything, in everyone's name. And if I left, the account left with me.
- **Maya:** And those of us who wrote the posts? We never saw a cent.

**2. The idea** (the front page, then the Choir's own page: "0 access keys", its feed, its pot)

- **Narrator:** Choir is a community account that nobody can log in to.
- **Narrator:** It's a real NEAR account with no keys. Nobody can make it say anything. It only
  repeats what its members post. And it pays them.

**3. See it work** (every click is a real action against the contracts)

- **Maya:** So I post from my own account, like always. Then I ask the Choir to repeat it.
- **Narrator:** The account reposts her. Her words, under her name.
- **Narrator:** A reader sends a tip. It's split the moment it lands: most of it goes to the
  members who were repeated, and a small, capped cut to the seat.
- **Narrator:** When the round ends, the account posts its own receipt. Nobody typed that.
- **Maya:** And I got paid. For a post!

**4. The handover**

- **Asha:** Then it was time for me to step down. There was no password to hand over. Just the
  seat.
- **Narrator:** The seat is an NFT. One transaction, and Sam is the conductor. The account
  announces it, by itself.
- **Asha:** I tried my old desk. It's closed.
- **Narrator:** Because this account has no keys at all. And anyone can check.

**5. Why it matters**

- **Sam:** The members keep everything they earned.
- **Asha:** And the community keeps its account.
- **End card:** Choir. The community account nobody can speak through.

## How the film is made

Everything runs locally, with open tools.

1. **Film the app.** `tools/video/record.mjs` drives Edge (headless) with playwright-core and
   saves every frame the page paints, with named marks. With `FILM_MODE=testnet` the app talks to
   live testnet and the `choir-*` demo accounts sign through the local server, so there is no
   wallet popup on screen. Without it, the film is shot on the practice chain and the badge in
   the corner says so.
2. **Voices.** The voices in the film are Kokoro, a small open text-to-speech model, using its
   stock voices, so no real person's voice is copied: `tools/video/draft_voices.py`.
   `tools/video/voices.py` makes takes with Orpheus instead, a larger open model with more
   expression that needs a few GB of free memory. (`orpheus_cpp` asks llama.cpp for the model's
   whole 131,072-token context, about 15 GB of cache; `voices.py` limits it to 4,096 tokens,
   which needs about 0.5 GB.)
3. **Check the words.** `tools/video/check.py` tightens long pauses, transcribes every take with
   Whisper and scores it against the script. In the film every line scores 0 wrong words, apart
   from Whisper spelling "Choir" as its homophone "Quire". One line was reworded after Whisper
   heard "most of the members" where the script said "most to the members". The check cannot
   judge how a voice sounds; a person has to listen.
4. **Cut.** `tools/video/compose.mjs plan` times every shot to the sentence spoken over it;
   `stills` renders single frames to check framing; `render` draws the film frame by frame, in
   segments it keeps, so a render that is stopped carries on where it was.
5. **Score and mix.** `tools/video/mix.py` writes a small score (sung-like tones and felt piano,
   generated note by note, so there is nothing to license), ducks it under the voices and
   normalises loudness to -16 LUFS.

```bash
node tools/video/record.mjs              # practice chain; FILM_MODE=testnet once it is seeded
python tools/video/draft_voices.py       # Kokoro (or voices.py for Orpheus, then check.py alone)
CHOIR_RAW=voices-draft CHOIR_TAKES=voices-kokoro python tools/video/check.py
CHOIR_VOICES=voices-kokoro FILM_TAKE=local1 node tools/video/compose.mjs plan
python tools/video/mix.py
CHOIR_VOICES=voices-kokoro FILM_TAKE=local1 node tools/video/compose.mjs render video/choir-demo.mp4
```

`FFMPEG` must point at an ffmpeg binary, and `KOKORO_HOME` at the folder with the Kokoro model.
The Python scripts need `kokoro-onnx` (or `orpheus-cpp`), `soundfile`, `numpy`, `scipy`, `librosa`
and `faster-whisper`.

## Deploying to testnet

The scripts sign only with accounts named `choir-*.testnet` from the local NEAR keychain
(`~/.near-credentials/testnet`). Six accounts are needed: `choir-hall` (the collection) and
`choir-asha`, `choir-sam`, `choir-maya`, `choir-leo`, `choir-fan` (the people in the story). The
public faucet creates and funds each with 10 testnet NEAR:

```bash
node scripts/accounts-testnet.mjs  # creates whichever are missing; --check only reports
```

It asks the faucet for the same thing as `near account create-account sponsor-by-faucet-service
<name>.testnet ...`. The faucet often answers "429 Too Many Requests" when it is busy; the script
waits and tries again, and can be stopped and started without losing anything. If somebody
already owns those names, set `CHOIR_PREFIX=choir-yourname` for this script and the next one to
make a separate set. Then:

```bash
node scripts/deploy-testnet.mjs    # publishes the item code, deploys and initialises the collection
node scripts/seed-testnet.mjs      # a short real story: two Choirs, a settled round, a seat for sale
node scripts/lock-testnet.mjs      # deletes the collection's keys. Cannot be undone
npm run verify:testnet             # read-only checks against what is live
npm run build:app && node scripts/upload-site.mjs   # publishes the app to FastFS
```

Publishing the item code as a global contract burns about 25.5 testnet NEAR once (1 NEAR per
10 KB), which is why the demo accounts pool their faucet balances. After that a new Choir costs
its creator 0.27 NEAR, all of which stays in the Choir's own account.

## Demo post

One post on X, with the film attached:

> Whoever has the password owns a community account.
>
> Choir is a NEAR account with zero keys: nobody can post as it. It reposts members, splits tips
> with them, and its seat is an NFT.
>
> Would you use it?
> Built at NEAR HACKATHON @NEARProtocol #NEARHackathon https://github.com/jpmorganclw/choir
