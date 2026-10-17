/** A Connections.csv as LinkedIn's data export writes it: a notes preamble, then the table. */
export const CONNECTIONS_CSV = [
  '﻿Notes:',
  '"When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have allowed their connections to see or download their email address."',
  '',
  'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
  'Ada,Lovelace,https://www.linkedin.com/in/ada,ada@example.com,Analytical Engines,"Engineer, Lead",15 Oct 2026',
  'Grace,Hopper,https://www.linkedin.com/in/grace,,US Navy,"Rear Admiral ""Amazing Grace""",03 Feb 2024',
  ',,,,,,',
  'Alan,Turing,https://www.linkedin.com/in/alan,,Analytical Engines,Researcher,12-Jun-23',
].join('\r\n');
