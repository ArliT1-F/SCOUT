Real-event proof for the product page (/welcome).

The landing page never invents a testimonial: while this folder holds nothing
publishable, the "community" section simply says the beta is still gathering
its first stories. To put genuine proof on the page, copy proof.example.json
to proof.json in this folder and fill it with material a real organiser has
agreed to see published:

  - kind "quote": their words verbatim, their name and role, their
    organisation/event and the date, plus their tournament logo dropped in
    this folder and referenced as "/proof/<file>".
  - kind "clip": a short recording of the overlay as it actually went out on
    air (and an optional poster frame), also stored in this folder and
    referenced as "/proof/<file>". Keep clips short (under ~30s) — the page
    lazy-loads them and never autoplays.

Rules the page enforces, so a half-filled file cannot publish anything:

  - an entry without "consent": true is skipped;
  - a quote without text, or a clip without a src, is skipped;
  - at most four entries are shown;
  - if proof.json is missing or unreadable the section shows nothing extra.

Consent is the organiser's to give and to withdraw: delete their entry (or
the whole file) and the page stops showing it on the next deploy. Nothing
here is uploaded anywhere — like everything else in public/, it is served
from the machine that runs the broadcast.
