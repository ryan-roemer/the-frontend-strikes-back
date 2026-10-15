// Chrome 148+ (desktop): on by default.
// Edge Canary/Dev 138+: edge://flags → "Prompt API for on-device language model".
const session = await LanguageModel.create();

console.log(await session.prompt("In one sentence, what is bikeshedding?"));

session.destroy();
