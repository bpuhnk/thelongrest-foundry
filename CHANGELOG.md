# Changelog

## 0.1.3

- **Re-importing removes NPCs your players can no longer see.** If you set an imported NPC back to
  *Hidden* in The Long Rest, or take it out of the session, the next **Import TLR** for that session
  removes its actor, and its tokens on every scene (a placed token would still show the name and
  image). Foundry sends every actor to every player's browser, so a hidden NPC mustn't stay in the world.
  - Only NPCs are removed. Encounter monsters and revealed facts stay, as before.
  - Only NPCs this module imported for that session and campaign: never ones you made yourself, or
    another session's or campaign's.
  - Nothing is removed if the import didn't complete (the session couldn't be fetched, or an actor
    failed to import).
  - The import notice says how many NPCs were removed; their names are written only to the GM's
    browser console.

## 0.1.2

- **The Import TLR button now appears straight after a world launches.** The Actors directory first
  draws itself before the module has connected, and until now nothing redrew it afterwards, so the
  button only showed up once something else refreshed the directory. The module now adds it as soon
  as it's ready (still GM-only, and still only once).

## 0.1.1

Fixes from the first real install.

- **Test connection uses what's in the form.** Pasting the address and token and clicking **Test
  connection** now saves them first (as **Save** does; an empty token field still keeps the saved
  token), instead of testing the old, empty settings.
- **Clearer connection messages.** With no token or no address, the message says what to do: paste a
  VTT connector token from The Long Rest (Campaign Settings → API access), or enter the address, then
  click **Test connection** or **Save**.
- **An empty import explains itself.** When a session has nothing player-visible yet, the import says
  why and how to change it (NPCs set to *Card only* or *Full details* and attached to a beat, combat beats
  linked to encounters, or a revealed fact), instead of "0 created, 0 updated". Combatants typed in
  without a Bestiary entry are reported as imported as basic actors.
- **A shorter Actors-directory button:** it now reads **Import TLR** (the full "Import session prep
  from The Long Rest" is its tooltip), so it fits the directory header. The Connect window's button is
  unchanged.
- **Releases:** a missed release can be run by hand from the repo's Actions tab, for an existing
  version tag only (never overwriting a release).

## 0.1.0

The first release. Needs Foundry v14 (14.367 or later) with the dnd5e 6.0 system.

- **Connect** a world to your campaign with a *VTT connector* token. The token is stored only in the
  GM's browser, and other token kinds are refused.
- **Import session prep:** the session's NPCs (as your players may see them), one folder of
  ready-to-drag monsters per prepared encounter, and a journal of the facts your players have
  learned. Importing again updates in place.
- **Live table state** from the active GM: the fight, turn order, player HP, public rolls and
  conditions. Hidden combatants, whispered, blind and hidden-creature rolls, and NPC HP (unless you
  opt in) never leave Foundry.
- **Reveals** appear in the session's journal within about 10 seconds while the session is running,
  with an optional chat card.
