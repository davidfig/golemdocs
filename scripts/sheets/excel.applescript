-- Has Microsoft Excel open workbooks, recalculate everything and save each as .xlsx (scripts/sheets/excel.ts runs it).
-- Arguments: pairs of input and output paths, inside Excel's sandbox folder; the two names must differ from each other and
-- from any workbook already open. Workbooks are closed by name, so whatever else is open in Excel is never touched. Excel's
-- alerts are turned off, so a file it would have to repair fails (or times out) instead of waiting for a click.
on run argv
	set results to {}
	set step to "starting"
	with timeout of 300 seconds
		tell application "Microsoft Excel"
			set display alerts to false
			try
				repeat with i from 1 to (count of argv) by 2
					set inputPath to item i of argv
					set outputPath to item (i + 1) of argv
					set step to "opening " & inputPath
					open workbook workbook file name inputPath
					set wb to workbook (my fileName(inputPath))
					set step to "calculating " & inputPath
					calculate full
					set step to "saving " & outputPath
					save workbook as wb filename outputPath file format Excel XML file format
					set step to "closing " & outputPath
					close workbook (my fileName(outputPath)) saving no
					set end of results to outputPath
				end repeat
			on error errText
				set display alerts to true
				error step & ": " & errText
			end try
			set display alerts to true
		end tell
	end timeout
	set AppleScript's text item delimiters to linefeed
	return results as text
end run

on fileName(posixPath)
	set AppleScript's text item delimiters to "/"
	set leaf to last text item of posixPath
	set AppleScript's text item delimiters to ""
	return leaf
end fileName
