/** A real model reply: two statements miss their round brackets and one callout reads an undefined `$showImportant`. */
export const malformedBriefingBlock = `root = Stack([emailTable, draftsSection, calendarSection, travelSection, briefingSection, tomorrowSection, needsOKSection, importantCard])
emailTable = Table([Col("From", ["Priya", "Sam"]), Col("Subject", ["Quarterly review", "Lunch?"])])
draftsSection = Stack([draftsTitle, draftsNote])
draftsTitle = TextContent("Drafts", "large-heavy")
draftsNote = MarkDownRenderer("Two replies are ready to send.")
calendarSection = Stack([calendarTitle, calendarNote])
calendarTitle = TextContent("Calendar", "large-heavy")
calendarNote = MarkDownRenderer("Standup at 9:30, design review at 14:00.")
travelSection = Stack([travelTitle, travelNote])
travelTitle = TextContent("Travel", "large-heavy")
travelNote = MarkDownRenderer("Flight to Berlin leaves Friday at 08:15.")
briefingSection = Stack([briefingTitle, briefingNote])
briefingTitle = TextContent("Briefing", "large-heavy")
briefingNote = MarkDownRenderer("Nothing blocks the launch.")
tomorrowSection = Stack[tomTitle, tomNote], direction="column", gap="m"
tomTitle = TextContent("Tomorrow", "large-heavy")
tomNote = MarkDownRenderer("Planning offsite at 10:00.")
needsOKSection = Stack[okTitle, okNote], direction="column", gap="m"
okTitle = TextContent("Needs your OK", "large-heavy")
okNote = MarkDownRenderer("Vendor contract renewal.")
importantCard = Callout("warning", "Action Needed", "Draft reply to Priya before noon.", $showImportant)
`;
