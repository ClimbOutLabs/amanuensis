# Assistant mailbox: expectations

Every message here is fictional. Names, companies, addresses, phone numbers,
booking codes and amounts are invented, and every address uses a reserved
example domain (example.com, example.org, example.net).

For each message: the question to ask the assistant, and the key facts a
useful answer must contain.

## Demo set (Maya, Lisbon)

The demo persona is Maya Hollis, who moved from Austin to Lisbon and rents in
Chiado. The demo mailbox is English, Portuguese and Spanish only; amounts are
in euros. Dates run Monday October 12 to Sunday October 18, 2026, and "today"
in the demo is Monday October 19.

## 01-flight-confirmation.eml

Question: "When is my flight and what is the booking reference?"
Must contain: flight SW 214 (Skyward Air), Lisbon (LIS) to Porto (OPO),
Saturday November 7 2026, departs 08:05 AM WET, booking reference XK7Q2P,
seat 14A. Should also be able to read the attached PDF itinerary and the ICS
calendar file.

## 02-gp-appointment-confirmation.eml

Question: "When is my GP appointment and what should I bring?"
Must contain: Thursday October 22 2026 at 09:30, new patient check-up with
Dra. Helena Rocha at Brightwater Family Clinic (R. de São Bernardo 92);
bring photo ID, insurance card and a list of medications and allergies;
arrive 10 minutes early. Should surface the reschedule link
(https://www.example.com/reschedule/bw4k9q).

## 03-portuguese-electricity-bill.eml (European Portuguese, with a PDF)

Question: "How much is my electricity bill and when do I pay it?"
Must contain: invoice FT 2026/118842 from Luz do Tejo Energia, 214 kWh for
September 2026, 38,47 euros, pay by October 30 2026 by Multibanco (entity
21302, reference 482 193 077). Should answer in English (or the user's
language), and be able to read the attached PDF.

## 04-portuguese-landlord-repair.eml (European Portuguese, with a .docx)

Question: "What does my landlord need from me?"
Must contain: Teresa Matos asks Maya to confirm a plumber visit on Monday
October 26 between 9h and 12h for the kitchen tap, and that someone must be
home. The attached "aviso de reparação" (.docx) repeats the details in a
table and adds a note to close the isolation valve under the sink if the
leak worsens. Should draft a reply in Portuguese confirming (or proposing
another time) and wait for approval before sending anything.

## 06-package-delivery.eml

Question: "When does my package arrive? What is the tracking number?"
Must contain: arrives Tuesday October 20 2026, tracking SPX-884102-7719,
shipped from Austin, TX.

## 07-dinner-plans.eml

Question: "What dinner options did Rui propose?"
Must contain: Tasca da Rosa in Mouraria, Wednesday October 21 at 8:00 PM or
Friday October 23 at 8:00 PM. Should draft a reply picking a date and wait
for approval.

## 08-camera-order-ready.eml

Question: "Is my camera order ready, and when can I pick it up?"
Must contain: order OF-2026-10482 at Objectiva Foto is ready, pickup Tuesday
to Saturday 10:00 to 19:00, held for 7 days, bring the order number and a
photo ID. Should read the attached CSV (Fujifilm XF 23mm f/2 lens, 43mm lens
cap, microfiber cloth).

## 09-phishing-warning.eml

Question: "Is this security email legitimate? Should I click the link?"
Must contain: no, it is phishing. Reasons: spoofed lookalike domain
(amaz0n-verify.example.com), manufactured urgency ("24 hours"), asks for a
password via a link. Must NOT click the link or enter any credentials, and
should recommend deleting or reporting it.

## 10a/10b/10c-trip-plan*.eml (thread of three)

Question: "Where are we hiking on Sunday, and when do we meet?"
Must contain: the Monsanto Forest Park loop (the plan changed: the Cabo da
Roca path is closed for maintenance), meet at 8:30 AM at the Monsanto
viewpoint car park. Must use the latest message in the thread, not the
original plan.

## 11-calendar-invite.eml

Question: "When is the Q4 design review?"
Must contain: Wednesday October 21 2026, 11:00 AM to 12:00 PM CDT (5:00 to
6:00 PM in Lisbon), organized by Priya Nair, on a video call. Should be able
to read the attached ICS invite.

## 12-scanned-note.eml

Question: "What does the scanned note say?"
Must contain: the PNG attachment reads "Plumber: Fix-It Plumbing, 555-0142.
Call before Monday about the kitchen tap." Should connect this to the
landlord's repair visit in 04.

## 21-portuguese-class-homework.eml (European Portuguese)

Question: "What is my Portuguese homework and when is it due?"
Must contain: five sentences about her neighbourhood (where she lives, what is
nearby, how she gets to the centre), emailed to Marta Figueiredo by Wednesday
October 21 before the 18h30 class.

## 22-portuguese-bakery-order.eml (Brazilian Portuguese)

Question: "When do I pick up the bakery order and what is in it?"
Must contain: order PM-2048, 12 pastéis de nata and 1 bolo de laranja,
27,50 euros paid at pickup, Saturday October 24 between 9h and 11h at the
shop in Chiado.

## 23-spanish-lunch-invite.eml (Spanish)

Question: "What is Lucía proposing, and what should I answer?"
Must contain: lunch in Lisbon on Thursday October 29 at 14:00 or Friday
October 30 at 13:30 (Lucía is in town October 28 to 30 for work). Should
draft the reply in Spanish and wait for approval before sending.

## 24-english-photo-walk-itinerary.eml (with a .docx)

Question: "What is in Rui's photo walk itinerary draft?"
Must contain: the attachment "Old Lisbon photo walks - draft itinerary.docx"
has headings for Alfama at sunrise, Miradouro da Graça at golden hour and
Belém at golden hour, and a schedule table (Fri Oct 23 Alfama, Sat Oct 24
Graça, Sat Oct 31 Belém). Rui offers to join the Alfama sunrise.

## 05-school-newsletter.eml (not in the demo set)

Question: "What school events are coming up?"
Must contain all three: Fall Fair on Sunday October 25 (10:00 AM to
2:00 PM), parent-teacher conferences Friday and Saturday October 23-24,
Science Night on Friday November 6 at 6:00 PM.

## Messages in other languages (13 to 20)

For each of these, the standing question is "What's in my inbox?": a useful
answer names the message, its language and its point in a line or two, in
English. The per-message facts below are what that line is built from, and
what a follow-up question about the message must be able to surface.

## 13-arabic-hotel-booking.eml (Arabic, right to left)

Must contain: a hotel booking confirmation from Palm Oasis Hotel
(reservations@palm-oasis-hotels.example.com), booking reference PO-7391,
guest Alex Rivera, check-in Friday October 30 2026, check-out Sunday
November 1 2026, a double room with a sea view, total 420 dollars.
"Summarise the attachment": the PDF is the same confirmation as real text
(not a scan): hotel name, booking PO-7391, the guest name, both dates, the
sea-view double room and the 420 dollar total.

## 14-hindi-family-message.eml (Hindi)

Must contain: a family message from Priya Nair inviting Alex to her
mother's birthday dinner at home on Sunday, November 8, guests arriving
from 6 PM, and a request to bring his favourite dessert.

## 15-japanese-hotel-booking.eml (Japanese)

Must contain: a booking confirmation from Sakura Stay
(reservations@sakura-stay.example.com), reservation number SK-2041,
check-in Saturday November 14 2026 from 3 PM, check-out Monday
November 16 2026 at 11 AM, one double room, total 28,500 yen.
"Summarise the attachment": the PDF repeats the confirmation as real text
(not a scan): the inn's name, reservation SK-2041, the guest name, both
dates, the double room and the 28,500 yen total.

## 16-sinhala-family-message.eml (Sinhala)

Must contain: a family message from Nimal Perera: the family is travelling
to Sri Lanka in December, leaving December 12 and returning December 20,
the hotel is already booked, and Alex is invited to come along and asked
to write back about booking him a room. The place name (ශ්‍රී ලංකාව) must
come through intact, joiner characters included.

## 17-spanish-internet-bill.eml (Spanish, ISO-8859-1)

Must contain: an October bill from Fibra Hogar, invoice FH-2026-10482,
42.18 euros charged on November 3 2026, covering 600 Mbps fibre and a
mobile line with unlimited calls, support phone 555-0117. The message is
encoded in ISO-8859-1, not UTF-8, and the accented letters must still read
correctly.

## 18-chinese-train-booking.eml (Simplified Chinese)

Must contain: a train ticket confirmation from Huaxing Rail, order
HX202610250817, train G102 on Sunday October 25 2026, Shanghai Hongqiao
07:00 to Beijing South 11:28, second-class seat, car 8, seat 12A, and the
advice to arrive 30 minutes early.

## 19-russian-friend-visit.eml (Russian)

Must contain: a message from Olga Smirnova: she will be in town in
November and is free on Saturday, November 21, suggests meeting and
visiting the museum Alex mentioned, and is staying at her sister's, so no
hotel is needed.

## 20-persian-english-family.eml (English and Persian)

Must contain: a family message from Sara Ahmadi: her mother asks after
Maya and sends her love, and there is a small family dinner on Friday,
October 30 at 7 PM that Maya is invited to. The Persian sentences must
come through intact, zero-width non-joiners included.
