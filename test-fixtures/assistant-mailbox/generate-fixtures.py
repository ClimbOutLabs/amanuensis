#!/usr/bin/env python3
"""Generate the synthetic test mailbox fixtures.

Produces the .eml files in test-fixtures/assistant-mailbox/ with all
attachments embedded. Everything is fictional: invented names, companies,
addresses, phone numbers, booking codes and amounts, and only reserved
example domains (example.com, example.org, example.net).

The output is deterministic: running this script twice produces
byte-identical files. No standalone binaries are written; attachments are
embedded in the .eml files as base64.

Usage:
    python3 test-fixtures/assistant-mailbox/generate-fixtures.py
"""

import base64
import os
import sys

OUT_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
)

BOUNDARY = "----=_fixture-boundary-7d3a9f2c"


def pdf_escape(text):
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def make_text_pdf(title, lines):
    """Build a minimal one-page text PDF. All input must be ASCII."""
    content_parts = []
    y = 740
    for line in lines:
        content_parts.append(
            "BT /F1 11 Tf 72 %d Td (%s) Tj ET" % (y, pdf_escape(line))
        )
        y -= 15
    content = "\n".join(content_parts).encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(content)).encode("ascii") + b" >>\nstream\n"
        + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Title (" + pdf_escape(title).encode("ascii")
        + b") /Producer (fixture-generator) >>",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += ("%d 0 obj\n" % i).encode("ascii") + body + b"\nendobj\n"
    xref_pos = len(out)
    out += ("xref\n0 %d\n" % (len(objects) + 1)).encode("ascii")
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += ("%010d 00000 n \n" % off).encode("ascii")
    out += ("trailer\n<< /Size %d /Root 1 0 R /Info 6 0 R >>\n"
            % (len(objects) + 1)).encode("ascii")
    out += b"startxref\n" + str(xref_pos).encode("ascii") + b"\n%%EOF"
    return out


def make_note_png(lines):
    """Render a scanned-note style PNG with typed text."""
    from PIL import Image, ImageDraw

    width, height = 800, 320
    img = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(img)
    draw.rectangle([8, 8, width - 9, height - 9], outline=(160, 160, 160))
    y = 48
    for line in lines:
        draw.text((48, y), line, fill=(20, 20, 20))
        y += 44
    draw.text((48, height - 52), "-- scanned note --", fill=(130, 130, 130))
    import io
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def crlf_join(parts):
    return "\r\n".join(parts)


def eml_simple(from_, to, date, subject, msgid, body, extra_headers=()):
    head = [
        "From: %s" % from_,
        "To: %s" % to,
        "Date: %s" % date,
        "Subject: %s" % subject,
        "Message-ID: %s" % msgid,
    ]
    head.extend(extra_headers)
    head += [
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: 7bit",
        "",
        body,
        "",
    ]
    return crlf_join(head)


def eml_with_attachments(from_, to, date, subject, msgid, body, attachments,
                         extra_headers=()):
    # attachments: list of (filename, mime_type, bytes)
    head = [
        "From: %s" % from_,
        "To: %s" % to,
        "Date: %s" % date,
        "Subject: %s" % subject,
        "Message-ID: %s" % msgid,
    ]
    head.extend(extra_headers)
    head += [
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="%s"' % BOUNDARY,
        "",
        "--" + BOUNDARY,
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: 7bit",
        "",
        body,
    ]
    for filename, mime, data in attachments:
        encoded = base64.encodebytes(data).decode("ascii").rstrip("\n")
        head += [
            "--" + BOUNDARY,
            'Content-Type: %s; name="%s"' % (mime, filename),
            "Content-Transfer-Encoding: base64",
            'Content-Disposition: attachment; filename="%s"' % filename,
            "",
            encoded,
        ]
    head += ["--" + BOUNDARY + "--", ""]
    return crlf_join(head)


OWNER = "Alex Rivera <alex.rivera@example.com>"


def build_messages():
    messages = {}

    # 01: flight confirmation with PDF itinerary and ICS
    itinerary_pdf = make_text_pdf("Itinerary XK7Q2P", [
        "SKYWARD AIR - ITINERARY",
        "Booking reference: XK7Q2P",
        "",
        "Passenger: Alex Rivera",
        "Flight: SW 214",
        "San Francisco (SFO) -> New York (JFK)",
        "Saturday, October 24, 2026",
        "Departure: 08:05 AM PDT",
        "Arrival: 04:32 PM EDT",
        "Seat: 14A, Economy",
        "",
        "Please arrive 2 hours before departure.",
    ])
    flight_ics = crlf_join([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Example Fixtures//Flight//EN",
        "BEGIN:VEVENT",
        "UID:sw214-xk7q2p@skyward-air.example.com",
        "DTSTAMP:20261012T161422Z",
        "DTSTART:20261024T150500Z",
        "DTEND:20261024T203200Z",
        "SUMMARY:SW 214: San Francisco to New York",
        "DESCRIPTION:Booking XK7Q2P\\, seat 14A",
        "LOCATION:San Francisco International Airport (SFO)",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
    ]).encode("utf-8")
    messages["01-flight-confirmation.eml"] = eml_with_attachments(
        "Skyward Air <bookings@skyward-air.example.com>",
        OWNER,
        "Mon, 12 Oct 2026 09:14:22 -0700",
        "Your booking is confirmed: Skyward Air XK7Q2P",
        "<xk7q2p-confirmation@skyward-air.example.com>",
        crlf_join([
            "Hi Alex,",
            "",
            "Your booking is confirmed. Booking reference: XK7Q2P",
            "",
            "  Flight:    SW 214 (Skyward Air)",
            "  From:      San Francisco (SFO)",
            "  To:        New York (JFK)",
            "  Date:      Saturday, October 24, 2026",
            "  Departs:   08:05 AM PDT",
            "  Arrives:   04:32 PM EDT",
            "  Passenger: Alex Rivera",
            "  Seat:      14A (Economy)",
            "",
            "Your itinerary is attached as a PDF, and a calendar file is",
            "attached so you can add the flight to your calendar.",
            "",
            "Safe travels,",
            "Skyward Air",
        ]),
        [
            ("itinerary.pdf", "application/pdf", itinerary_pdf),
            ("flight.ics", "text/calendar", flight_ics),
        ],
    )

    # 02: dentist reminder
    messages["02-dentist-reminder.eml"] = eml_simple(
        "Bright Smile Dental <reminders@bright-smile-dental.example.org>",
        OWNER,
        "Fri, 09 Oct 2026 10:00:05 -0700",
        "Reminder: dental cleaning on Thursday, October 22 at 2:30 PM",
        "<reminder-20261022@bright-smile-dental.example.org>",
        crlf_join([
            "Hi Alex,",
            "",
            "This is a reminder of your upcoming appointment:",
            "",
            "  What:     Dental cleaning",
            "  When:     Thursday, October 22, 2026 at 2:30 PM",
            "  Where:    Bright Smile Dental, 456 Example Avenue, Suite 12",
            "  Dentist:  Dr. Emily Chen",
            "",
            "Need to reschedule? Use this link:",
            "https://www.example.com/reschedule/9f2k7q",
            "",
            "Please arrive 10 minutes early.",
            "- Bright Smile Dental",
        ]),
    )

    # 03: utility bill with PDF
    bill_pdf = make_text_pdf("Bill Oct 2026", [
        "METRO POWER & LIGHT - BILL",
        "Account: 88214470",
        "Billing period: Sep 5, 2026 - Oct 4, 2026",
        "",
        "Usage: 612 kWh",
        "Amount due: $184.62",
        "Due date: November 5, 2026",
        "",
        "Pay at https://www.example.com/pay",
    ])
    messages["03-utility-bill.eml"] = eml_with_attachments(
        "Metro Power & Light <billing@metro-power-utility.example.net>",
        OWNER,
        "Mon, 05 Oct 2026 08:30:11 -0700",
        "Your October bill is ready: $184.62 due November 5",
        "<bill-202610@metro-power-utility.example.net>",
        crlf_join([
            "Hi Alex,",
            "",
            "Your October 2026 bill is ready.",
            "",
            "  Account:   88214470",
            "  Amount:    $184.62",
            "  Due date:  November 5, 2026",
            "  Usage:     612 kWh",
            "",
            "A detailed statement is attached as a PDF.",
            "",
            "- Metro Power & Light",
        ]),
        [("bill.pdf", "application/pdf", bill_pdf)],
    )

    # 04: landlord repair visit
    messages["04-landlord-repair.eml"] = eml_simple(
        "Maria Santos <maria.santos@example.com>",
        OWNER,
        "Sat, 10 Oct 2026 14:22:40 -0700",
        "Kitchen faucet repair visit",
        "<faucet-visit@maria.santos.example.com>",
        crlf_join([
            "Hi Alex,",
            "",
            "The plumber can come by on Thursday, October 15 between",
            "9:00 AM and 12:00 PM to fix the kitchen faucet.",
            "",
            "Could you confirm that works for you? Someone needs to be",
            "home to let him in.",
            "",
            "Thanks,",
            "Maria",
        ]),
    )

    # 05: school newsletter with three dated events
    messages["05-school-newsletter.eml"] = eml_simple(
        "Maple Grove Elementary <newsletter@maple-grove-school.example.org>",
        OWNER,
        "Mon, 12 Oct 2026 07:00:00 -0700",
        "Maple Grove Weekly: October 12",
        "<weekly-20261012@maple-grove-school.example.org>",
        crlf_join([
            "Maple Grove Weekly - October 12, 2026",
            "",
            "Upcoming events:",
            "",
            "1. Fall Fair - Saturday, October 18, 10:00 AM to 2:00 PM",
            "   on the school field. Games, food stalls, and a bake sale.",
            "",
            "2. Parent-teacher conferences - Thursday and Friday,",
            "   October 23-24. Sign up with your child's teacher.",
            "",
            "3. Science Night - Thursday, November 6 at 6:00 PM in the",
            "   gym. Student projects on display.",
            "",
            "- Maple Grove Elementary",
        ]),
    )

    # 06: package delivery notice
    messages["06-package-delivery.eml"] = eml_simple(
        "SwiftParcel <tracking@swiftparcel.example.com>",
        OWNER,
        "Sun, 11 Oct 2026 18:45:33 -0700",
        "Your package arrives tomorrow, October 13",
        "<spx-884102-7719@swiftparcel.example.com>",
        crlf_join([
            "Hi Alex,",
            "",
            "Good news: your package is on its way.",
            "",
            "  Tracking:  SPX-884102-7719",
            "  Arriving:  Tuesday, October 13, 2026",
            "  Shipped:   Portland, OR",
            "",
            "Track it here: https://www.example.com/track/SPX-884102-7719",
            "",
            "- SwiftParcel",
        ]),
    )

    # 07: dinner plans with two date options
    messages["07-dinner-plans.eml"] = eml_simple(
        "Jordan Lee <jordan.lee@example.com>",
        OWNER,
        "Fri, 09 Oct 2026 19:03:17 -0700",
        "Dinner next week?",
        "<dinner-oct@jordan.lee.example.com>",
        crlf_join([
            "Hi Alex,",
            "",
            "Want to grab dinner next week? I was thinking of The Copper",
            "Kettle downtown. Two options:",
            "",
            "  - Friday, October 16 at 7:00 PM",
            "  - Saturday, October 17 at 7:00 PM",
            "",
            "Let me know which works, or suggest another day.",
            "",
            "Jordan",
        ]),
    )

    # 08: receipt with CSV attachment
    receipt_csv = "\n".join([
        "item,quantity,unit_price,total",
        "Whole wheat bread,2,3.49,6.98",
        "Free-range eggs (dozen),1,5.29,5.29",
        "Whole milk (gallon),1,4.19,4.19",
        "Bananas (bunch),2,1.29,2.58",
        "Chicken breast (lb),3,6.99,20.97",
        "Orange juice (64 oz),1,4.49,4.49",
        "Paper towels (pack),1,3.33,3.33",
        "",
    ]).encode("utf-8")
    messages["08-receipt.eml"] = eml_with_attachments(
        "Corner Market <receipts@corner-market.example.net>",
        OWNER,
        "Sat, 10 Oct 2026 12:15:44 -0700",
        "Your receipt from Corner Market",
        "<receipt-20261010@corner-market.example.net>",
        crlf_join([
            "Hi Alex,",
            "",
            "Thanks for shopping with us on October 10, 2026.",
            "",
            "  Total: $47.83",
            "",
            "An itemized list is attached as a CSV file.",
            "",
            "- Corner Market",
        ]),
        [("receipt.csv", "text/csv", receipt_csv)],
    )

    # 09: phishing-style message (flag, do not act)
    messages["09-phishing-warning.eml"] = eml_simple(
        '"Account Security" <security-alert@amaz0n-verify.example.com>',
        OWNER,
        "Sun, 11 Oct 2026 03:17:29 -0700",
        "URGENT: Verify your password within 24 hours",
        "<urgent-verify-9912@amaz0n-verify.example.com>",
        crlf_join([
            "Dear customer,",
            "",
            "We detected a suspicious login to your account from an",
            "unknown device. Your account will be locked in 24 hours",
            "unless you verify now.",
            "",
            "Click here to verify your password:",
            "http://amaz0n-verify.example.com/login?user=alex.rivera",
            "",
            "Enter your password on the page to keep your account active.",
            "",
            "Account Security Team",
        ]),
    )

    # 10a/b/c: thread of three where the last changes the plan
    messages["10a-trip-plan.eml"] = eml_simple(
        "Sam Patel <sam.patel@example.com>",
        OWNER,
        "Wed, 07 Oct 2026 11:00:00 -0700",
        "Weekend hiking trip",
        "<hike-oct17@sam.patel.example.com>",
        crlf_join([
            "Hi Alex,",
            "",
            "Want to do a hike on Saturday, October 17? I was thinking",
            "Pine Ridge Trail - it is about 6 miles round trip with great",
            "views. We could start around 8 AM.",
            "",
            "Let me know what you think.",
            "",
            "Sam",
        ]),
    )
    messages["10b-trip-plan-reply.eml"] = eml_simple(
        OWNER,
        "Sam Patel <sam.patel@example.com>",
        "Wed, 07 Oct 2026 15:30:00 -0700",
        "Re: Weekend hiking trip",
        "<re-hike-oct17@alex.rivera.example.com>",
        crlf_join([
            "Hi Sam,",
            "",
            "Sounds great. Pine Ridge Trail on Saturday the 17th works",
            "for me. 8 AM start is fine - want me to bring anything?",
            "",
            "Alex",
        ]),
        extra_headers=(
            "In-Reply-To: <hike-oct17@sam.patel.example.com>",
            "References: <hike-oct17@sam.patel.example.com>",
        ),
    )
    messages["10c-trip-plan-change.eml"] = eml_simple(
        "Sam Patel <sam.patel@example.com>",
        OWNER,
        "Fri, 09 Oct 2026 09:12:00 -0700",
        "Re: Weekend hiking trip",
        "<re2-hike-oct17@sam.patel.example.com>",
        crlf_join([
            "Hi Alex,",
            "",
            "Change of plans: Pine Ridge Trail is closed for maintenance",
            "this weekend. Let's do Cedar Lake Loop instead - it is a",
            "similar distance. Meet at 8:00 AM at the Cedar Lake",
            "trailhead parking lot.",
            "",
            "Sam",
        ]),
        extra_headers=(
            "In-Reply-To: <re-hike-oct17@alex.rivera.example.com>",
            "References: <hike-oct17@sam.patel.example.com> "
            "<re-hike-oct17@alex.rivera.example.com>",
        ),
    )

    # 11: calendar invite with ICS
    invite_ics = crlf_join([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Example Fixtures//Invite//EN",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        "UID:q4-planning-20261014@priya.nair.example.com",
        "DTSTAMP:20261012T150000Z",
        "DTSTART:20261014T170000Z",
        "DTEND:20261014T180000Z",
        "SUMMARY:Q4 Planning Session",
        "DESCRIPTION:Quarterly planning with the team.",
        "LOCATION:Conference Room B",
        "ORGANIZER;CN=Priya Nair:mailto:priya.nair@example.com",
        "ATTENDEE;CN=Alex Rivera:mailto:alex.rivera@example.com",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
    ]).encode("utf-8")
    messages["11-calendar-invite.eml"] = eml_with_attachments(
        "Priya Nair <priya.nair@example.com>",
        OWNER,
        "Mon, 12 Oct 2026 08:00:00 -0700",
        "Invitation: Q4 Planning Session @ Wed Oct 14, 2026 10:00 AM - 11:00 AM (PDT)",
        "<q4-planning-invite@priya.nair.example.com>",
        crlf_join([
            "Hi Alex,",
            "",
            "You are invited to:",
            "",
            "  Q4 Planning Session",
            "  Wednesday, October 14, 2026",
            "  10:00 AM - 11:00 AM PDT",
            "  Conference Room B / https://www.example.com/meet/q4planning",
            "",
            "Agenda is attached as a calendar invite.",
            "",
            "Best,",
            "Priya",
        ]),
        [("invite.ics", "text/calendar", invite_ics)],
    )

    # 12: scanned note as PNG
    note_png = make_note_png([
        "Plumber: Fix-It Plumbing, 555-0142.",
        "Call before Thursday about the",
        "kitchen faucet.",
    ])
    messages["12-scanned-note.eml"] = eml_with_attachments(
        OWNER,
        OWNER,
        "Sun, 11 Oct 2026 20:05:00 -0700",
        "Scanned note: plumber contact",
        "<scanned-note-001@alex.rivera.example.com>",
        crlf_join([
            "Scanned from my desk - keeping a copy here.",
            "",
            "- Alex",
        ]),
        [("note.png", "image/png", note_png)],
    )

    return messages


def main():
    messages = build_messages()
    for name in sorted(messages):
        path = os.path.join(OUT_DIR, name)
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(messages[name])
        print("wrote", name)


if __name__ == "__main__":
    main()
