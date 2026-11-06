# Spec: iCloud calendar and the provider picker order

**Status:** approved

## Problem

The Calendar card and the installer offer built-in addresses for a few CalDAV providers. iCloud is not one of them, so an iCloud user has to pick Other and find an address by hand. Typing `https://caldav.icloud.com/` under Other does not work either: iCloud signs you in on that server but keeps the calendars on a second server (such as `p42-caldav.icloud.com`), and the calendar tool server only talks to the one server it is started on.

The email and calendar pickers also list providers in an order that is hard to scan.

## Change

1. **iCloud preset.** Add iCloud to the calendar presets at `https://caldav.icloud.com/`, in the app and in the installer, with the same app-specific password help page as iCloud mail.
2. **Calendars on another server.** The calendar connector's sign-in check walks the same steps the tool server takes: the saved address, the account's principal, and its calendar home set. Every server it connects to must pass the connector's address rules (https, no private or reserved addresses, nothing on the connector's own network), whoever named it. The principal must be on the server that named it. A home set on another server must belong to the same provider (its name ends in the saved server's own domain, so `p42-caldav.icloud.com` for `caldav.icloud.com`), with no list of named providers. When the home set is on such a server, the check is run again from there, the way the tool server will run it, and the tool server is started on that server. The whole check has one time limit and never holds up the connector. The address the tool server starts on passes the rules again at every start, and a guard inside the tool server applies them to every lookup it makes. The saved address does not change, so the card still shows the provider by its own address.
3. **Picker order.** Both pickers list providers alphabetically by the name a person sees, ignoring case, with Other last. The installer numbers its menus in the same order. Because the numbers can change, the installer's provider flags take a name only.

## Privacy

The app-specific password stays in the calendar connector's own storage, as before. It is sent only to servers that passed the address rules. No new data is stored: the second server is found again each time the connector starts.

## Testing

Synthetic data only. Unit tests cover the preset tables, the installer menus and numbers, the provider shown for a saved address, and a two-server walk against fake CalDAV servers: a home set on a second server is accepted once it passes the rules, and refused when it is on a forbidden address, on another provider's server, not https, spread over two servers, or pointing on to a third, and a principal on another server is never sent the login. A live check with a real iCloud account and app-specific password is done by hand before merge.

## Out of scope

Proton, Outlook and Microsoft 365 (no CalDAV with an app password) and Zoho calendar (no checked address) stay under Other.
