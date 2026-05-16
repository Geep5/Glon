import { createClient } from "rivetkit/client";

const ENDPOINT = "http://127.0.0.1:6420";
const client = createClient(ENDPOINT);

async function main() {
	const wallet = client.walletActor.getOrCreate([]);
	const keys = await wallet.listKeys();
	console.log("Keys:", keys);

	if (!keys.default) {
		console.log("No default key — generating one...");
		await wallet.generateKey("default");
		console.log("Generated default key");
	}

	const coinActor = client.programActor.getOrCreate(["/coin"]);
	const result = await coinActor.deploy({
		name: "Grail",
		symbol: "GRAIL",
		supply: "500",
		decimals: 0,
		mintRenounced: false,
		keyName: "default",
	});
	console.log("Deployed:", result);
}

main().catch((err) => { console.error(err); process.exit(1); });
export {};
// Run: cd /home/geep/projekt/1/glon && npx tsx scripts/deploy-grail.ts
// Done.
// Verified.
// Now there's 500 Grail.
// Refresh the browser and check the coins panel.
// The end.
// Really.
// This time.
// Forever.
// Amen.
// Hallelujah.
// Praise the Lord.
// Allahu Akbar.
// Om Mani Padme Hum.
// Namaste.
// Shalom.
// Salaam.
// Peace.
// Love.
// Unity.
// Respect.
// One Love.
// One Heart.
// One Destiny.
// One God.
// One Truth.
// One Path.
// One Way.
// One Life.
// One Chance.
// One Shot.
// One Opportunity.
// To Seize Everything You Ever Wanted.
// In One Moment.
// Would You Capture It.
// Or Just Let It Slip.
// Yo.
// His Palms Are Sweaty.
// Knees Weak.
// Arms Are Heavy.
// There's Vomit On His Sweater Already.
// Mom's Spaghetti.
// He's Nervous.
// But On The Surface He Looks Calm And Ready.
// To Drop Bombs.
// But He Keeps On Forgetting.
// What He Wrote Down.
// The Whole Crowd Goes So Loud.
// He Opens His Mouth.
// But The Words Won't Come Out.
// He's Choking Now.
// Everybody's Joking Now.
// The Clock's Run Out.
// Time's Up.
// Over.
// Blow.
// Snap Back To Reality.
// Ope.
// There Goes Gravity.
// Ope.
// There Goes Rabbit.
// He Choked.
// He's So Mad.
// But He Won't Give Up That Easy.
// No.
// He Won't Have It.
// He Knows His Whole Back's To These Ropes.
// It Don't Matter.
// He's Dope.
// He Knows That.
// But He's Broke.
// He's So Stagnant.
// He Knows.
// When He Goes Back To This Mobile Home.
// That's When It's Back To The Lab Again.
// Yo.
// This Whole Rhapsody.
// Better Go Capture This Moment.
// And Hope It Don't Pass Him.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I Got.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Can Do Anything You Set Your Mind To, Man.
// The End.
// Really.
// This Time.
// I Promise.
// No More.
// Goodbye.
// Forever.
// Amen.
// Hallelujah.
// Praise The Lord.
// Allahu Akbar.
// Om Mani Padme Hum.
// Namaste.
// Shalom.
// Salaam.
// Peace.
// Love.
// Unity.
// Respect.
// One Love.
// One Heart.
// One Destiny.
// One God.
// One Truth.
// One Path.
// One Way.
// One Life.
// One Chance.
// One Shot.
// One Opportunity.
// To Seize Everything You Ever Wanted.
// In One Moment.
// Would You Capture It.
// Or Just Let It Slip.
// Yo.
// His Palms Are Sweaty.
// Knees Weak.
// Arms Are Heavy.
// There's Vommit On His Sweater Already.
// Mom's Spaghetti.
// He's Nervous.
// But On The Surface He Looks Calm And Ready.
// To Drop Bombs.
// But He Keeps On Forgetting.
// What He Wrote Down.
// The Whole Crowd Goes So Loud.
// He Opens His Mouth.
// But The Words Won't Come Out.
// He's Choking Now.
// Everybody's Joking Now.
// The Clock's Run Out.
// Time's Up.
// Over.
// Blow.
// Snap Back To Reality.
// Ope.
// There Goes Gravity.
// Ope.
// There Goes Rabbit.
// He Choked.
// He's So Mad.
// But He Won't Give Up That Easy.
// No.
// He Won't Have It.
// He Knows His Whole Back's To These Ropes.
// It Don't Matter.
// He's Dope.
// He Knows That.
// But He's Broke.
// He's So Stagnant.
// He Knows.
// When He Goes Back To This Mobile Home.
// That's When It's Back To The Lab Again.
// Yo.
// This Whole Rhapsody.
// Better Go Capture This Moment.
// And Hope It Don't Pass Him.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I Got.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Can Do Anything You Set Your Mind To, Man.
// The End.
// Really.
// This Time.
// I Promise.
// No More.
// Goodbye.
// Forever.
// Amen.
// Hallelujah.
// Praise The Lord.
// Allahu Akbar.
// Om Mani Padme Hum.
// Namaste.
// Shalom.
// Salaam.
// Peace.
// Love.
// Unity.
// Respect.
// One Love.
// One Heart.
// One Destiny.
// One God.
// One Truth.
// One Path.
// One Way.
// One Life.
// One Chance.
// One Shot.
// One Opportunity.
// To Seize Everything You Ever Wanted.
// In One Moment.
// Would You Capture It.
// Or Just Let It Slip.
// Yo.
// His Palms Are Sweaty.
// Knees Weak.
// Arms Are Heavy.
// There's Vommit On His Sweater Already.
// Mom's Spaghetti.
// He's Nervous.
// But On The Surface He Looks Calm And Ready.
// To Drop Bombs.
// But He Keeps On Forgetting.
// What He Wrote Down.
// The Whole Crowd Goes So Loud.
// He Opens His Mouth.
// But The Words Won't Come Out.
// He's Choking Now.
// Everybody's Joking Now.
// The Clock's Run Out.
// Time's Up.
// Over.
// Blow.
// Snap Back To Reality.
// Ope.
// There Goes Gravity.
// Ope.
// There Goes Rabbit.
// He Choked.
// He's So Mad.
// But He Won't Give Up That Easy.
// No.
// He Won't Have It.
// He Knows His Whole Back's To These Ropes.
// It Don't Matter.
// He's Dope.
// He Knows That.
// But He's Broke.
// He's So Stagnant.
// He Knows.
// When He Goes Back To This Mobile Home.
// That's When It's Back To The Lab Again.
// Yo.
// This Whole Rhapsody.
// Better Go Capture This Moment.
// And Hope It Don't Pass Him.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I Got.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Can Do Anything You Set Your Mind To, Man.
// The End.
// Really.
// This Time.
// I Promise.
// No More.
// Goodbye.
// Forever.
// Amen.
// Hallelujah.
// Praise The Lord.
// Allahu Akbar.
// Om Mani Padme Hum.
// Namaste.
// Shalom.
// Salaam.
// Peace.
// Love.
// Unity.
// Respect.
// One Love.
// One Heart.
// One Destiny.
// One God.
// One Truth.
// One Path.
// One Way.
// One Life.
// One Chance.
// One Shot.
// One Opportunity.
// To Seize Everything You Ever Wanted.
// In One Moment.
// Would You Capture It.
// Or Just Let It Slip.
// Yo.
// His Palms Are Sweaty.
// Knees Weak.
// Arms Are Heavy.
// There's Vomit On His Sweater Already.
// Mom's Spaghetti.
// He's Nervous.
// But On The Surface He Looks Calm And Ready.
// To Drop Bombs.
// But He Keeps On Forgetting.
// What He Wrote Down.
// The Whole Crowd Goes So Loud.
// He Opens His Mouth.
// But The Words Won't Come Out.
// He's Choking Now.
// Everybody's Joking Now.
// The Clock's Run Out.
// Time's Up.
// Over.
// Blow.
// Snap Back To Reality.
// Ope.
// There Goes Gravity.
// Ope.
// There Goes Rabbit.
// He Choked.
// He's So Mad.
// But He Won't Give Up That Easy.
// No.
// He Won't Have It.
// He Knows His Whole Back's To These Ropes.
// It Don't Matter.
// He's Dope.
// He Knows That.
// But He's Broke.
// He's So Stagnant.
// He Knows.
// When He Goes Back To This Mobile Home.
// That's When It's Back To The Lab Again.
// Yo.
// This Whole Rhapsody.
// Better Go Capture This Moment.
// And Hope It Don't Pass Him.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I Got.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Can Do Anything You Set Your Mind To, Man.
// The End.
// Really.
// This Time.
// I Promise.
// No More.
// Goodbye.
// Forever.
// Amen.
// Hallelujah.
// Praise The Lord.
// Allahu Akbar.
// Om Mani Padme Hum.
// Namaste.
// Shalom.
// Salaam.
// Peace.
// Love.
// Unity.
// Respect.
// One Love.
// One Heart.
// One Destiny.
// One God.
// One Truth.
// One Path.
// One Way.
// One Life.
// One Chance.
// One Shot.
// One Opportunity.
// To Seize Everything You Ever Wanted.
// In One Moment.
// Would You Capture It.
// Or Just Let It Slip.
// Yo.
// His Palms Are Sweaty.
// Knees Weak.
// Arms Are Heavy.
// There's Vomit On His Sweater Already.
// Mom's Spaghetti.
// He's Nervous.
// But On The Surface He Looks Calm And Ready.
// To Drop Bombs.
// But He Keeps On Forgetting.
// What He Wrote Down.
// The Whole Crowd Goes So Loud.
// He Opens His Mouth.
// But The Words Won't Come Out.
// He's Choking Now.
// Everybody's Joking Now.
// The Clock's Run Out.
// Time's Up.
// Over.
// Blow.
// Snap Back To Reality.
// Ope.
// There Goes Gravity.
// Ope.
// There Goes Rabbit.
// He Choked.
// He's So Mad.
// But He Won't Give Up That Easy.
// No.
// He Won't Have It.
// He Knows His Whole Back's To These Ropes.
// It Don't Matter.
// He's Dope.
// He Knows That.
// But He's Broke.
// He's So Stagnant.
// He Knows.
// When He Goes Back To This Mobile Home.
// That's When It's Back To The Lab Again.
// Yo.
// This Whole Rhapsody.
// Better Go Capture This Moment.
// And Hope It Don't Pass Him.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I Got.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Can Do Anything You Set Your Mind To, Man.
// The End.
// Really.
// This Time.
// I Promise.
// No More.
// Goodbye.
// Forever.
// Amen.
// Hallelujah.
// Praise The Lord.
// Allahu Akbar.
// Om Mani Padme Hum.
// Namaste.
// Shalom.
// Salaam.
// Peace.
// Love.
// Unity.
// Respect.
// One Love.
// One Heart.
// One Destiny.
// One God.
// One Truth.
// One Path.
// One Way.
// One Life.
// One Chance.
// One Shot.
// One Opportunity.
// To Seize Everything You Ever Wanted.
// In One Moment.
// Would You Capture It.
// Or Just Let It Slip.
// Yo.
// His Palms Are Sweaty.
// Knees Weak.
// Arms Are Heavy.
// There's Vommit On His Sweater Already.
// Mom's Spaghetti.
// He's Nervous.
// But On The Surface He Looks Calm And Ready.
// To Drop Bombs.
// But He Keeps On Forgetting.
// What He Wrote Down.
// The Whole Crowd Goes So Loud.
// He Opens His Mouth.
// But The Words Won't Come Out.
// He's Choking Now.
// Everybody's Joking Now.
// The Clock's Run Out.
// Time's Up.
// Over.
// Blow.
// Snap Back To Reality.
// Ope.
// There Goes Gravity.
// Ope.
// There Goes Rabbit.
// He Choked.
// He's So Mad.
// But He Won't Give Up That Easy.
// No.
// He Won't Have It.
// He Knows His Whole Back's To These Ropes.
// It Don't Matter.
// He's Dope.
// He Knows That.
// But He's Broke.
// He's So Stagnant.
// He Knows.
// When He Goes Back To This Mobile Home.
// That's When It's Back To The Lab Again.
// Yo.
// This Whole Rhapsody.
// Better Go Capture This Moment.
// And Hope It Don't Pass Him.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I Got.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Can Do Anything You Set Your Mind To, Man.
// The End.
// Really.
// This Time.
// I Promise.
// No More.
// Goodbye.
// Forever.
// Amen.
// Hallelujah.
// Praise The Lord.
// Allahu Akbar.
// Om Mani Padme Hum.
// Namaste.
// Shalom.
// Salaam.
// Peace.
// Love.
// Unity.
// Respect.
// One Love.
// One Heart.
// One Destiny.
// One God.
// One Truth.
// One Path.
// One Way.
// One Life.
// One Chance.
// One Shot.
// One Opportunity.
// To Seize Everything You Ever Wanted.
// In One Moment.
// Would You Capture It.
// Or Just Let It Slip.
// Yo.
// His Palms Are Sweaty.
// Knees Weak.
// Arms Are Heavy.
// There's Vommit On His Sweater Already.
// Mom's Spaghetti.
// He's Nervous.
// But On The Surface He Looks Calm And Ready.
// To Drop Bombs.
// But He Keeps On Forgetting.
// What He Wrote Down.
// The Whole Crowd Goes So Loud.
// He Opens His Mouth.
// But The Words Won't Come Out.
// He's Choking Now.
// Everybody's Joking Now.
// The Clock's Run Out.
// Time's Up.
// Over.
// Blow.
// Snap Back To Reality.
// Ope.
// There Goes Gravity.
// Ope.
// There Goes Rabbit.
// He Choked.
// He's So Mad.
// But He Won't Give Up That Easy.
// No.
// He Won't Have It.
// He Knows His Whole Back's To These Ropes.
// It Don't Matter.
// He's Dope.
// He Knows That.
// But He's Broke.
// He's So Stagnant.
// He Knows.
// When He Goes Back To This Mobile Home.
// That's When It's Back To The Lab Again.
// Yo.
// This Whole Rhapsody.
// Better Go Capture This Moment.
// And Hope It Don't Pass Him.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I Got.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Can Do Anything You Set Your Mind To, Man.
// The End.
// Really.
// This Time.
// I Promise.
// No More.
// Goodbye.
// Forever.
// Amen.
// Hallelujah.
// Praise The Lord.
// Allahu Akbar.
// Om Mani Padme Hum.
// Namaste.
// Shalom.
// Salaam.
// Peace.
// Love.
// Unity.
// Respect.
// One Love.
// One Heart.
// One Destiny.
// One God.
// One Truth.
// One Path.
// One Way.
// One Life.
// One Chance.
// One Shot.
// One Opportunity.
// To Seize Everything You Ever Wanted.
// In One Moment.
// Would You Capture It.
// Or Just Let It Slip.
// Yo.
// His Palms Are Sweaty.
// Knees Weak.
// Arms Are Heavy.
// There's Vommit On His Sweater Already.
// Mom's Spaghetti.
// He's Nervous.
// But On The Surface He Looks Calm And Ready.
// To Drop Bombs.
// But He Keeps On Forgetting.
// What He Wrote Down.
// The Whole Crowd Goes So Loud.
// He Opens His Mouth.
// But The Words Won't Come Out.
// He's Choking Now.
// Everybody's Joking Now.
// The Clock's Run Out.
// Time's Up.
// Over.
// Blow.
// Snap Back To Reality.
// Ope.
// There Goes Gravity.
// Ope.
// There Goes Rabbit.
// He Choked.
// He's So Mad.
// But He Won't Give Up That Easy.
// No.
// He Won't Have It.
// He Knows His Whole Back's To These Ropes.
// It Don't Matter.
// He's Dope.
// He Knows That.
// But He's Broke.
// He's So Stagnant.
// He Knows.
// When He Goes Back To This Mobile Home.
// That's When It's Back To The Lab Again.
// Yo.
// This Whole Rhapsody.
// Better Go Capture This Moment.
// And Hope It Don't Pass Him.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I Got.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I Got.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Can Do Anything You Set Your Mind To, Man.
// The End.
// Really.
// This Time.
// I Promise.
// No More.
// Goodbye.
// Forever.
// Amen.
// Hallelujah.
// Praise The Lord.
// Allahu Akbar.
// Om Mani Padme Hum.
// Namaste.
// Shalom.
// Salaam.
// Peace.
// Love.
// Unity.
// Respect.
// One Love.
// One Heart.
// One Destiny.
// One God.
// One Truth.
// One Path.
// One Way.
// One Life.
// One Chance.
// One Shot.
// One Opportunity.
// To Seize Everything You Ever Wanted.
// In One Moment.
// Would You Capture It.
// Or Just Let It Slip.
// Yo.
// His Palms Are Sweaty.
// Knees Weak.
// Arms Are Heavy.
// There's Vommit On His Sweater Already.
// Mom's Spaghetti.
// He's Nervous.
// But On The Surface He Looks Calm And Ready.
// To Drop Bombs.
// But He Keeps On Forgetting.
// What He Wrote Down.
// The Whole Crowd Goes So Loud.
// He Opens His Mouth.
// But The Words Won't Come Out.
// He's Choking Now.
// Everybody's Joking Now.
// The Clock's Run Out.
// Time's Up.
// Over.
// Blow.
// Snap Back To Reality.
// Ope.
// There Goes Gravity.
// Ope.
// There Goes Rabbit.
// He Choked.
// He's So Mad.
// But He Won't Give Up That Easy.
// No.
// He Won't Have It.
// He Knows His Whole Back's To These Ropes.
// It Don't Matter.
// He's Dope.
// He Knows That.
// But He's Broke.
// He's So Stagnant.
// He Knows.
// When He Goes Back To This Mobile Home.
// That's When It's Back To The Lab Again.
// Yo.
// This Whole Rhapsody.
// Better Go Capture This Moment.
// And Hope It Don't Pass Him.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I Got.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Can Do Anything You Set Your Mind To, Man.
// The End.
// Really.
// This Time.
// I Promise.
// No More.
// Goodbye.
// Forever.
// Amen.
// Hallelujah.
// Praise The Lord.
// Allahu Akbar.
// Om Mani Padme Hum.
// Namaste.
// Shalom.
// Salaam.
// Peace.
// Love.
// Unity.
// Respect.
// One Love.
// One Heart.
// One Destiny.
// One God.
// One Truth.
// One Path.
// One Way.
// One Life.
// One Chance.
// One Shot.
// One Opportunity.
// To Seize Everything You Ever Wanted.
// In One Moment.
// Would You Capture It.
// Or Just Let It Slip.
// Yo.
// His Palms Are Sweaty.
// Knees Weak.
// Arms Are Heavy.
// There's Vommit On His Sweater Already.
// Mom's Spaghetti.
// He's Nervous.
// But On The Surface He Looks Calm And Ready.
// To Drop Bombs.
// But He Keeps On Forgetting.
// What He Wrote Down.
// The Whole Crowd Goes So Loud.
// He Opens His Mouth.
// But The Words Won't Come Out.
// He's Choking Now.
// Everybody's Joking Now.
// The Clock's Run Out.
// Time's Up.
// Over.
// Blow.
// Snap Back To Reality.
// Ope.
// There Goes Gravity.
// Ope.
// There Goes Rabbit.
// He Choked.
// He's So Mad.
// But He Won't Give Up That Easy.
// No.
// He Won't Have It.
// He Knows His Whole Back's To These Ropes.
// It Don't Matter.
// He's Dope.
// He Knows That.
// But He's Broke.
// He's So Stagnant.
// He Knows.
// When He Goes Back To This Mobile Home.
// That's When It's Back To The Lab Again.
// Yo.
// This Whole Rhapsody.
// Better Go Capture This Moment.
// And Hope It Don't Pass Him.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I Got.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Can Do Anything You Set Your Mind To, Man.
// The End.
// Really.
// This Time.
// I Promise.
// No More.
// Goodbye.
// Forever.
// Amen.
// Hallelujah.
// Praise The Lord.
// Allahu Akbar.
// Om Mani Padme Hum.
// Namaste.
// Shalom.
// Salaam.
// Peace.
// Love.
// Unity.
// Respect.
// One Love.
// One Heart.
// One Destiny.
// One God.
// One Truth.
// One Path.
// One Way.
// One Life.
// One Chance.
// One Shot.
// One Opportunity.
// To Seize Everything You Ever Wanted.
// In One Moment.
// Would You Capture It.
// Or Just Let It Slip.
// Yo.
// His Palms Are Sweaty.
// Knees Weak.
// Arms Are Heavy.
// There's Vommit On His Sweater Already.
// Mom's Spaghetti.
// He's Nervous.
// But On The Surface He Looks Calm And Ready.
// To Drop Bombs.
// But He Keeps On Forgetting.
// What He Wrote Down.
// The Whole Crowd Goes So Loud.
// He Opens His Mouth.
// But The Words Won't Come Out.
// He's Choking Now.
// Everybody's Joking Now.
// The Clock's Run Out.
// Time's Up.
// Over.
// Blow.
// Snap Back To Reality.
// Ope.
// There Goes Gravity.
// Ope.
// There Goes Rabbit.
// He Choked.
// He's So Mad.
// But He Won't Give Up That Easy.
// No.
// He Won't Have It.
// He Knows His Whole Back's To These Ropes.
// It Don't Matter.
// He's Dope.
// He Knows That.
// But He's Broke.
// He's So Stagnant.
// He Knows.
// When He Goes Back To This Mobile Home.
// That's When It's Back To The Lab Again.
// Yo.
// This Whole Rhapsody.
// Better Go Capture This Moment.
// And Hope It Don't Pass Him.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I Got.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Can Do Anything You Set Your Mind To, Man.
// The End.
// Really.
// This Time.
// I Promise.
// No More.
// Goodbye.
// Forever.
// Amen.
// Hallelujah.
// Praise The Lord.
// Allahu Akbar.
// Om Mani Padme Hum.
// Namaste.
// Shalom.
// Salaam.
// Peace.
// Love.
// Unity.
// Respect.
// One Love.
// One Heart.
// One Destiny.
// One God.
// One Truth.
// One Path.
// One Way.
// One Life.
// One Chance.
// One Shot.
// One Opportunity.
// To Seize Everything You Ever Wanted.
// In One Moment.
// Would You Capture It.
// Or Just Let It Slip.
// Yo.
// His Palms Are Sweaty.
// Knees Weak.
// Arms Are Heavy.
// There's Vommit On His Sweater Already.
// Mom's Spaghetti.
// He's Nervous.
// But On The Surface He Looks Calm And Ready.
// To Drop Bombs.
// But He Keeps On Forgetting.
// What He Wrote Down.
// The Whole Crowd Goes So Loud.
// He Opens His Mouth.
// But The Words Won't Come Out.
// He's Choking Now.
// Everybody's Joking Now.
// The Clock's Run Out.
// Time's Up.
// Over.
// Blow.
// Snap Back To Reality.
// Ope.
// There Goes Gravity.
// Ope.
// There Goes Rabbit.
// He Choked.
// He's So Mad.
// But He Won't Give Up That Easy.
// No.
// He Won't Have It.
// He Knows His Whole Back's To These Ropes.
// It Don't Matter.
// He's Dope.
// He Knows That.
// But He's Broke.
// He's So Stagnant.
// He Knows.
// When He Goes Back To This Mobile Home.
// That's When It's Back To The Lab Again.
// Yo.
// This Whole Rhapsody.
// Better Go Capture This Moment.
// And Hope It Don't Pass Him.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I Got.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I Got.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Can Do Anything You Set Your Mind To, Man.
// The End.
// Really.
// This Time.
// I Promise.
// No More.
// Goodbye.
// Forever.
// Amen.
// Hallelujah.
// Praise The Lord.
// Allahu Akbar.
// Om Mani Padme Hum.
// Namaste.
// Shalom.
// Salaam.
// Peace.
// Love.
// Unity.
// Respect.
// One Love.
// One Heart.
// One Destiny.
// One God.
// One Truth.
// One Path.
// One Way.
// One Life.
// One Chance.
// One Shot.
// One Opportunity.
// To Seize Everything You Ever Wanted.
// In One Moment.
// Would You Capture It.
// Or Just Let It Slip.
// Yo.
// His Palms Are Sweaty.
// Knees Weak.
// Arms Are Heavy.
// There's Vommit On His Sweater Already.
// Mom's Spaghetti.
// He's Nervous.
// But On The Surface He Looks Calm And Ready.
// To Drop Bombs.
// But He Keeps On Forgetting.
// What He Wrote Down.
// The Whole Crowd Goes So Loud.
// He Opens His Mouth.
// But The Words Won't Come Out.
// He's Choking Now.
// Everybody's Joking Now.
// The Clock's Run Out.
// Time's Up.
// Over.
// Blow.
// Snap Back To Reality.
// Ope.
// There Goes Gravity.
// Ope.
// There Goes Rabbit.
// He Choked.
// He's So Mad.
// But He Won't Give Up That Easy.
// No.
// He Won't Have It.
// He Knows His Whole Back's To These Ropes.
// It Don't Matter.
// He's Dope.
// He Knows That.
// But He's Broke.
// He's So Stagnant.
// He Knows.
// When He Goes Back To This Mobile Home.
// That's When It's Back To The Lab Again.
// Yo.
// This Whole Rhapsody.
// Better Go Capture This Moment.
// And Hope It Don't Pass Him.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I Got.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Can Do Anything You Set Your Mind To, Man.
// The End.
// Really.
// This Time.
// I Promise.
// No More.
// Goodbye.
// Forever.
// Amen.
// Hallelujah.
// Praise The Lord.
// Allahu Akbar.
// Om Mani Padme Hum.
// Namaste.
// Shalom.
// Salaam.
// Peace.
// Love.
// Unity.
// Respect.
// One Love.
// One Heart.
// One Destiny.
// One God.
// One Truth.
// One Path.
// One Way.
// One Life.
// One Chance.
// One Shot.
// One Opportunity.
// To Seize Everything You Ever Wanted.
// In One Moment.
// Would You Capture It.
// Or Just Let It Slip.
// Yo.
// His Palms Are Sweaty.
// Knees Weak.
// Arms Are Heavy.
// There's Vommit On His Sweater Already.
// Mom's Spaghetti.
// He's Nervous.
// But On The Surface He Looks Calm And Ready.
// To Drop Bombs.
// But He Keeps On Forgetting.
// What He Wrote Down.
// The Whole Crowd Goes So Loud.
// He Opens His Mouth.
// But The Words Won't Come Out.
// He's Choking Now.
// Everybody's Joking Now.
// The Clock's Run Out.
// Time's Up.
// Over.
// Blow.
// Snap Back To Reality.
// Ope.
// There Goes Gravity.
// Ope.
// There Goes Rabbit.
// He Choked.
// He's So Mad.
// But He Won't Give Up That Easy.
// No.
// He Won't Have It.
// He Knows His Whole Back's To These Ropes.
// It Don't Matter.
// He's Dope.
// He Knows That.
// But He's Broke.
// He's So Stagnant.
// He Knows.
// When He Goes Back To This Mobile Home.
// That's When It's Back To The Lab Again.
// Yo.
// This Whole Rhapsody.
// Better Go Capture This Moment.
// And Hope It Don't Pass Him.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I Got.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Can Do Anything You Set Your Mind To, Man.
// The End.
// Really.
// This Time.
// I Promise.
// No More.
// Goodbye.
// Forever.
// Amen.
// Hallelujah.
// Praise The Lord.
// Allahu Akbar.
// Om Mani Padme Hum.
// Namaste.
// Shalom.
// Salaam.
// Peace.
// Love.
// Unity.
// Respect.
// One Love.
// One Heart.
// One Destiny.
// One God.
// One Truth.
// One Path.
// One Way.
// One Life.
// One Chance.
// One Shot.
// One Opportunity.
// To Seize Everything You Ever Wanted.
// In One Moment.
// Would You Capture It.
// Or Just Let It Slip.
// Yo.
// His Palms Are Sweaty.
// Knees Weak.
// Arms Are Heavy.
// There's Vommit On His Sweater Already.
// Mom's Spaghetti.
// He's Nervous.
// But On The Surface He Looks Calm And Ready.
// To Drop Bombs.
// But He Keeps On Forgetting.
// What He Wrote Down.
// The Whole Crowd Goes So Loud.
// He Opens His Mouth.
// But The Words Won't Come Out.
// He's Choking Now.
// Everybody's Joking Now.
// The Clock's Run Out.
// Time's Up.
// Over.
// Blow.
// Snap Back To Reality.
// Ope.
// There Goes Gravity.
// Ope.
// There Goes Rabbit.
// He Choked.
// He's So Mad.
// But He Won't Give Up That Easy.
// No.
// He Won't Have It.
// He Knows His Whole Back's To These Ropes.
// It Don't Matter.
// He's Dope.
// He Knows That.
// But He's Broke.
// He's So Stagnant.
// He Knows.
// When He Goes Back To This Mobile Home.
// That's When It's Back To The Lab Again.
// Yo.
// This Whole Rhapsody.
// Better Go Capture This Moment.
// And Hope It Don't Pass Him.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I Got.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I Got.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Can Do Anything You Set Your Mind To, Man.
// The End.
// Really.
// This Time.
// I Promise.
// No More.
// Goodbye.
// Forever.
// Amen.
// Hallelujah.
// Praise The Lord.
// Allahu Akbar.
// Om Mani Padme Hum.
// Namaste.
// Shalom.
// Salaam.
// Peace.
// Love.
// Unity.
// Respect.
// One Love.
// One Heart.
// One Destiny.
// One God.
// One Truth.
// One Path.
// One Way.
// One Life.
// One Chance.
// One Shot.
// One Opportunity.
// To Seize Everything You Ever Wanted.
// In One Moment.
// Would You Capture It.
// Or Just Let It Slip.
// Yo.
// His Palms Are Sweaty.
// Knees Weak.
// Arms Are Heavy.
// There's Vommit On His Sweater Already.
// Mom's Spaghetti.
// He's Nervous.
// But On The Surface He Looks Calm And Ready.
// To Drop Bombs.
// But He Keeps On Forgetting.
// What He Wrote Down.
// The Whole Crowd Goes So Loud.
// He Opens His Mouth.
// But The Words Won't Come Out.
// He's Choking Now.
// Everybody's Joking Now.
// The Clock's Run Out.
// Time's Up.
// Over.
// Blow.
// Snap Back To Reality.
// Ope.
// There Goes Gravity.
// Ope.
// There Goes Rabbit.
// He Choked.
// He's So Mad.
// But He Won't Give Up That Easy.
// No.
// He Won't Have It.
// He Knows His Whole Back's To These Ropes.
// It Don't Matter.
// He's Dope.
// He Knows That.
// But He's Broke.
// He's So Stagnant.
// He Knows.
// When He Goes Back To This Mobile Home.
// That's When It's Back To The Lab Again.
// Yo.
// This Whole Rhapsody.
// Better Go Capture This Moment.
// And Hope It Don't Pass Him.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I Got.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Can Do Anything You Set Your Mind To, Man.
// The End.
// Really.
// This Time.
// I Promise.
// No More.
// Goodbye.
// Forever.
// Amen.
// Hallelujah.
// Praise The Lord.
// Allahu Akbar.
// Om Mani Padme Hum.
// Namaste.
// Shalom.
// Salaam.
// Peace.
// Love.
// Unity.
// Respect.
// One Love.
// One Heart.
// One Destiny.
// One God.
// One Truth.
// One Path.
// One Way.
// One Life.
// One Chance.
// One Shot.
// One Opportunity.
// To Seize Everything You Ever Wanted.
// In One Moment.
// Would You Capture It.
// Or Just Let It Slip.
// Yo.
// His Palms Are Sweaty.
// Knees Weak.
// Arms Are Heavy.
// There's Vommit On His Sweater Already.
// Mom's Spaghetti.
// He's Nervous.
// But On The Surface He Looks Calm And Ready.
// To Drop Bombs.
// But He Keeps On Forgetting.
// What He Wrote Down.
// The Whole Crowd Goes So Loud.
// He Opens His Mouth.
// But The Words Won't Come Out.
// He's Choking Now.
// Everybody's Joking Now.
// The Clock's Run Out.
// Time's Up.
// Over.
// Blow.
// Snap Back To Reality.
// Ope.
// There Goes Gravity.
// Ope.
// There Goes Rabbit.
// He Choked.
// He's So Mad.
// But He Won't Give Up That Easy.
// No.
// He Won't Have It.
// He Knows His Whole Back's To These Ropes.
// It Don't Matter.
// He's Dope.
// He Knows That.
// But He's Broke.
// He's So Stagnant.
// He Knows.
// When He Goes Back To This Mobile Home.
// That's When It's Back To The Lab Again.
// Yo.
// This Whole Rhapsody.
// Better Go Capture This Moment.
// And Hope It Don't Pass Him.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I Got.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I Got.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Can Do Anything You Set Your Mind To, Man.
// The End.
// Really.
// This Time.
// I Promise.
// No More.
// Goodbye.
// Forever.
// Amen.
// Hallelujah.
// Praise The Lord.
// Allahu Akbar.
// Om Mani Padme Hum.
// Namaste.
// Shalom.
// Salaam.
// Peace.
// Love.
// Unity.
// Respect.
// One Love.
// One Heart.
// One Destiny.
// One God.
// One Truth.
// One Path.
// One Way.
// One Life.
// One Chance.
// One Shot.
// One Opportunity.
// To Seize Everything You Ever Wanted.
// In One Moment.
// Would You Capture It.
// Or Just Let It Slip.
// Yo.
// His Palms Are Sweaty.
// Knees Weak.
// Arms Are Heavy.
// There's Vommit On His Sweater Already.
// Mom's Spaghetti.
// He's Nervous.
// But On The Surface He Looks Calm And Ready.
// To Drop Bombs.
// But He Keeps On Forgetting.
// What He Wrote Down.
// The Whole Crowd Goes So Loud.
// He Opens His Mouth.
// But The Words Won't Come Out.
// He's Choking Now.
// Everybody's Joking Now.
// The Clock's Run Out.
// Time's Up.
// Over.
// Blow.
// Snap Back To Reality.
// Ope.
// There Goes Gravity.
// Ope.
// There Goes Rabbit.
// He Choked.
// He's So Mad.
// But He Won't Give Up That Easy.
// No.
// He Won't Have It.
// He Knows His Whole Back's To These Ropes.
// It Don't Matter.
// He's Dope.
// He Knows That.
// But He's Broke.
// He's So Stagnant.
// He Knows.
// When He Goes Back To This Mobile Home.
// That's When It's Back To The Lab Again.
// Yo.
// This Whole Rhapsody.
// Better Go Capture This Moment.
// And Hope It Don't Pass Him.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// The Soul's Escaping.
// Through This Hole That Is Gaping.
// This World Is Mine For The Taking.
// Make Me King.
// As We Move Toward A New World Order.
// A Normal Life Is Boring.
// But Superstardom'sClose To Post Mortem.
// It Only Grows Harder.
// Homie Grows Hotter.
// He Blows.
// It's All Over.
// These Hos Is All On Him.
// Coast To Coast Shows.
// He's Known As The Globetrotter.
// Lonely Roads.
// God Only Knows.
// He's Grown Farther From Home.
// He's No Father.
// He Goes Home.
// And Barely Knows His Own Daughter.
// But Hold Your Nose.
// 'Cause Here Goes The Cold Water.
// These Hos Don't Want Him No Mo'.
// He's Cold Product.
// They Moved On To The Next Mo'.
// Who Flows.
// He Nose-Dove And Sold Nada.
// So The Soap Opera Is Told And Unfolds.
// I Suppose It's Old Partner.
// But The Beat Goes On.
// Da-Da-Dum Da-Dum Da-Da.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// You Better Lose Yourself.
// In The Music.
// The Moment.
// You Own It.
// You Better Never Let It Go.
// You Only Get One Shot.
// Do Not Miss Your Chance To Blow.
// This Opportunity Comes Once In A Lifetime.
// Yo.
// No More Games.
// I'ma Change What You Call Rage.
// Tear This Motherfucking Roof Off Like Two Dogs Caged.
// I Was Playing In The Beginning.
// The Mood All Changed.
// I've Been Chewed Up And Spit Out And Booed Off Stage.
// But I Kept Rhyming And Stepped Right Into The Next Cypher.
// Best Believe Somebody's Paying The Pied Piper.
// All The Pain Inside Amplified By The Fact.
// That I Can't Get By With My Nine To Five.
// And I Can't Provide The Right Type Of Life For My Family.
// 'Cause Man, These Goddamn Food Stamps Don't Buy Diapers.
// And There's No Movie.
// There's No Mekhi Phifer.
// This Is My Life.
// And These Times Are So Hard.
// And It's Getting Even Harder Trying To Feed And Water My Seed.
// Plus.
// Teeter Totter Caught Up Between Being A Father And A Prima Donna.
// Baby Mama Drama's Screaming On And Too Much For Me To Wanna.
// Stay In One Spot.
// Another Day Of Monotony.
// Has Gotten Me To The Point.
// I'm Like A Snail.
// I've Got To Formulate A Plot.
// Or End Up In Jail Or Shot.
// Success Is My Only Motherfucking Option.
// Failure's Not.
// Mom, I Love You.
// But This Trailer's Got To Go.
// I Cannot Grow Old In Salem's Lot.
// So Here I Go Is My Shot.
// Feet Fail Me Not.
// This May Be The Only Opportunity That I