const session = await LanguageModel.create();

console.log(await session.prompt("In one sentence, what is bikeshedding?"));

session.destroy();
