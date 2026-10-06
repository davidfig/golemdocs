// Common English typing mistakes, corrected as the word is finished (see autocorrect.ts). Only forms that
// are never a word of their own are here ("teh", not "form" for "from"), so a correction is never wrong
// and spell check is left with the doubtful ones. A word in the user's replacement list or dictionary wins.

const PAIRS = `
teh the, hte the, adn and, taht that, thier their, thsi this, tihs this, waht what, wnat want, abotu about, jsut just, ahve have, hvae have,
wich which, whcih which, wihch which, whith with, wiht with, becuase because, becasue because, beacuse because, untill until,
recieve receive, recieved received, reciept receipt, occured occurred, occurence occurrence, occassion occasion, ocasion occasion,
seperate separate, definately definitely, definatly definitely, definitly definitely, tommorow tomorrow, tomorow tomorrow,
accomodate accommodate, acommodate accommodate, adress address, agressive aggressive, apparant apparent, begining beginning,
beleive believe, belive believe, cemetary cemetery, collegue colleague, comming coming, commited committed, comittee committee,
concious conscious, curiousity curiosity, dissapear disappear, dissapoint disappoint, embarass embarrass, enviroment environment,
existance existence, experiance experience, foriegn foreign, freind friend, goverment government, grammer grammar, gaurd guard,
happend happened, harrass harass, immediatly immediately, imediately immediately, independant independent, intresting interesting,
knowlege knowledge, liason liaison, libary library, lenght length, maintainance maintenance, millenium millennium, mispell misspell,
neccessary necessary, necesary necessary, noticable noticeable, oppurtunity opportunity, orignal original, paralel parallel,
parliment parliament, percieve perceive, persistant persistent, posession possession, possesion possession, prefered preferred,
privelege privilege, probaly probably, probly probably, publically publicly, realy really, refered referred, relevent relevant,
religous religious, remeber remember, responsability responsibility, rythm rhythm, sieze seize, similiar similar, sincerly sincerely,
succesful successful, successfull successful, sucess success, suprise surprise, suprised surprised, tendancy tendency,
threshhold threshold, tounge tongue, truely truly, twelth twelfth, unforseen unforeseen, unfortunatly unfortunately, usefull useful,
wierd weird, writting writing, alot a lot, alwasy always, anwser answer, arguement argument, athiest atheist, buisness business,
bussiness business, catagory category, chnage change, completly completely, diffrent different, eigth eighth, fourty forty,
gratefull grateful, guidence guidance, hieght height, ignorence ignorance, inteligence intelligence, mischievious mischievous,
nieghbor neighbor, dont don't, doesnt doesn't, didnt didn't, isnt isn't, wasnt wasn't, couldnt couldn't, wouldnt wouldn't,
shouldnt shouldn't, hasnt hasn't, havent haven't, arent aren't, werent weren't
`;

/** Misspelling (lowercase) to its correction (lowercase). */
export const TYPOS: ReadonlyMap<string, string> = new Map(
  PAIRS.split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair): [string, string] => {
      const at = pair.indexOf(' ');
      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
);

/** `replacement` written the way `typed` was: "Teh" gives "The", "TEH" gives "THE". */
export function matchCase(typed: string, replacement: string): string {
  if (typed.length > 1 && typed === typed.toUpperCase() && typed !== typed.toLowerCase()) return replacement.toUpperCase();
  const first = typed.charAt(0);
  if (first !== first.toLowerCase()) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  return replacement;
}
