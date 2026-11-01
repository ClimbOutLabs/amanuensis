# Spec: Read common document attachments

**Status:** implemented

## Problem

People forward Aman whatever lands in their inbox: a lease as a Word file, a bank statement as a spreadsheet, a slide deck, a calendar invite, an email forwarded as an attachment. Aman read only PDFs and images. Everything else got "convert it to PDF", which a person on a phone cannot do, or was left for the model to open with `run_code`, which a small local model often gets wrong.

## Solution

Every common attachment format is read the same way PDFs are: inside the sandbox, before the model sees the message, with page-addressable text the model can cite and page through.

## 1. Formats

| Kind         | Extensions                                                                           |
| ------------ | ------------------------------------------------------------------------------------ |
| Word         | `.docx`, `.docm`, `.dotx`, `.doc`                                                    |
| Excel        | `.xlsx`, `.xlsm`, `.xls`                                                             |
| CSV          | `.csv`, `.tsv`                                                                       |
| PowerPoint   | `.pptx`, `.pptm`, `.ppsx`                                                            |
| OpenDocument | `.odt`, `.ods`, `.odp`                                                               |
| RTF          | `.rtf`                                                                               |
| Web page     | `.html`, `.htm`, `.xhtml`                                                            |
| Email        | `.eml`, `.msg`, with the text of their attachments, nested emails up to three levels |
| Text         | `.txt`, `.md`, `.json`, `.xml`, `.ics`, `.vcf`, `.log`, `.yaml`                      |

PDFs and images keep their existing path (native text, then OCR). A PDF or image inside a saved email is named, not read; it can be saved as its own file and read.

Not covered: `.ppt` and other pre-2007 PowerPoint, Word 6/95 and Excel 5/95. They get a plain "save it as .pptx/.docx/.xlsx or PDF" message.

## 2. How a file is read

- One script, Python standard library only, run with `python3 -I -S` in the chat's sandbox under `ulimit -v` (2 GB) and `timeout 60`. No new package in any sandbox image, so the local sandbox, Docker and slots all read the same way.
- The script decides the format from the bytes (zip, compound file, RTF header, PDF header), then the extension. An RTF or HTML file saved as `.doc`, or HTML or tab-separated text saved as `.xls`, is read for what it is.
- Output: plain text lines. Tables and spreadsheet rows are cells joined by `|`. Spreadsheets start each sheet with `Sheet: <name>`, slides with `Slide <n>`. Spreadsheet dates come out as dates.
- The server cuts the text into pages of about 3,000 characters, so `extract_document_text` pages through it with `page_start`/`page_end` like a PDF, and an open-ended tool read shows a short window and names the next range.

## 3. Limits and safety

- Existing caps hold: 25 MB per file, the shared per-call and per-session page, character and byte budgets.
- One read may unpack at most 100 MB and 5,000 zip entries in total, shared by any zip-based files nested inside an email; a password-protected zip entry is refused.
- At most 1,000,000 characters per file; the result says when a file held more.
- An XML part that declares a document type is refused, so no entity expansion and no external entities.
- Compound-file chains, directory trees and spreadsheet records are bounds-checked and loop-checked.
- Every failure is a fixed code turned into a plain sentence with a next step (damaged, password-protected, very old format, too large, too slow, not a readable document). No raw error reaches the message, from the reader or from the sandbox around it, because it could quote the file or name sandbox paths; the server log keeps it.
- The same holds for reading a project file by path and for the report tools. A missing file, a folder or a file over the size limit is told apart by its error type, never by the error's wording. A report the renderer refuses still names what to change.
- Text from a file is data, not instructions, as for PDFs.

## 4. Tests

Invented files are built at test time (no binaries in the repo): Word, Excel, PowerPoint and OpenDocument zips from XML, and `.doc`, `.xls`, `.msg` and encrypted-Office files from a small compound-file writer. The tests run the sandbox's own script on them.
