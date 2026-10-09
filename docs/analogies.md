# Analogies

Research behind the "We've been here before" slide (`RowsSlide` in chapter 2). It
compares web AI today with two shifts the audience has already lived through. Dates
were checked against the sources listed under each section in October 2026.

## Web apps, 2004–2015: from backend to browser

The slide row reads "All backend" → "Moves to the browser" → "Progressive web apps".

| Date         | Event                                                                                              | Slide step                   |
| ------------ | -------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1990s        | Server-rendered pages; every click is a full page load (general knowledge, not separately sourced) | All backend                  |
| Mar 1999     | XMLHTTP ships in IE5 (MSXML 2), built by Microsoft's Outlook Web Access team in 1998               | Moves to the browser (start) |
| Mar 11, 2003 | Steven Champeon and Nick Finck coin "progressive enhancement" at SXSW Interactive                  | (the principle; see below)   |
| Apr 2004     | Gmail: a browser-heavy app that works across browsers                                              | Moves to the browser         |
| Feb 18, 2005 | Jesse James Garrett names "Ajax", citing Google Maps and Google Suggest                            | Moves to the browser         |
| Apr 5, 2006  | First W3C draft of the `XMLHttpRequest` spec                                                       | Moves to the browser         |
| Aug 26, 2006 | jQuery 1.0                                                                                         | Moves to the browser         |
| Oct 2010     | Backbone (Oct 13) and AngularJS (Oct 20), the first wave of single-page app frameworks             | Moves to the browser         |
| May 29, 2013 | React open-sourced at JSConf US                                                                    | Moves to the browser         |
| Jun 15, 2015 | Alex Russell and Frances Berriman coin "progressive web apps"                                      | Progressive web apps         |

Why the row ends on progressive web apps and not progressive enhancement: the term
"progressive enhancement" dates from 2003, before most of the move to the browser, so
putting it last would get the order wrong. Progressive web apps (2015) really do come
last, and they apply the same idea: a baseline web app that works everywhere, plus
offline and install where the browser supports them. The speaker notes mention both.

Why 2004–2015: Gmail to progressive web apps. 2005–2015 (starting at Ajax) would also
work.

Sources:

- [Progressive enhancement (Wikipedia)](https://en.wikipedia.org/wiki/Progressive_enhancement)
- [The inclusive web of progressive enhancement (History of the Web)](https://thehistoryoftheweb.com/the-inclusive-web-of-progressive-enhancement/)
- [Ajax (programming) (Wikipedia)](<https://en.wikipedia.org/wiki/Ajax_(programming)>)
- [The story of XMLHTTP (Alex Hopmann)](https://www.alexhopmann.com/page/the-story-of-xmlhttp)
- [20 years ago: AJAX revolutionizes web development (heise)](https://heise.de/-10285844)
- [jQuery (Wikipedia)](https://en.wikipedia.org/wiki/JQuery) and the [jQuery 1.0 announcement](https://blog.jquery.com/2006/08/26/jquery-10/comment-page-2)
- [Backbone.js (Wikipedia)](https://en.wikipedia.org/wiki/Backbone.js)
- [The Brief History of Google's AngularJS](https://2017-web-development.readthedocs.io/en/latest/final/michael_b/index.html)
- [React 2013 (Web Design Museum)](https://www.webdesignmuseum.org/web-design-history/react-2013)
- [Progressive web app (Wikipedia)](https://en.wikipedia.org/wiki/Progressive_web_app)

## AI, 2022–2023: small context, hard-won quality, RAG

The slide row reads "Small context" → "Hard-won quality" → "RAG fills the gaps". The
point: browser models today are at roughly the stage cloud models were in 2022–2023.
The web AI article measured 1K–9K of usable context on most browser setups (Chrome's
Prompt API reported 9,216 tokens), which is the same range as below.

| Date         | Event                                                                                    | Slide step         |
| ------------ | ---------------------------------------------------------------------------------------- | ------------------ |
| 2020         | Lewis et al. introduce retrieval-augmented generation (RAG) at NeurIPS                   | RAG fills the gaps |
| 2022         | Wei et al., chain-of-thought prompting; it only helped models of about 100B parameters   | Hard-won quality   |
| Nov 30, 2022 | ChatGPT launches on GPT-3.5                                                              | Small context      |
| Feb 2023     | LLaMA (7B–65B), 2,048-token context                                                      | Small context      |
| Mar 1, 2023  | ChatGPT API (`gpt-3.5-turbo`), 4,096-token context at launch                             | Small context      |
| Mar 14, 2023 | GPT-4: 8K context by default, 32K in a limited API version                               | Small context      |
| 2023         | "The year of RAG": vector databases, LangChain and LlamaIndex take off                   | RAG fills the gaps |
| Jul 6, 2023  | Liu et al., "Lost in the Middle": models miss facts placed mid-context                   | Hard-won quality   |
| Jul 18, 2023 | Llama 2 (7B–70B), 4,096-token context                                                    | Small context      |
| Nov 6, 2023  | GPT-4 Turbo, 128K context (OpenAI DevDay); Claude 2.1 follows with 200K later that month | End of the era     |

Talking points it supports:

- **Small context:** 2K–8K was normal for most of 2023, and that is where browser
  models are now.
- **Hard-won quality:** prompt engineering was a discipline of its own. Chain-of-thought
  prompting didn't help small models at all, which matches what we see with small
  browser models.
- **RAG fills the gaps:** with little context and limited knowledge, retrieval was how
  you got your own data in. Browser vector search does the same job in the tab.

Sources:

- [ChatGPT explained (Geekflare)](https://geekflare.com/blog/chatgpt-explained/) and [GPT-3.5 Turbo (Long-term Wiki)](https://www.longtermwiki.com/wiki/gpt-3-5-turbo)
- [GPT-4 (Wikipedia)](https://en.wikipedia.org/wiki/GPT-4) and [OpenAI is testing a version of GPT-4 that can remember long conversations (TechCrunch)](https://techcrunch.com/2023/03/14/openai-is-testing-a-version-of-gpt-4-that-can-remember-long-conversations/)
- [New models and developer products announced at DevDay (OpenAI)](https://openai.com/index/new-models-and-developer-products-announced-at-devday/)
- [Anthropic introduces Claude 2.1 with 200K context window (Search Engine Journal)](https://www.searchenginejournal.com/anthropic-introduces-claude-2-1-with-200k-context-window/501907)
- [Meta Llama LLM models context window details (Code2care)](https://code2care.org/q/meta-llama-llm-models-context-window-length-details/)
- [RAG: the Lewis 2020 paper (Latenode)](https://latenode.com/news/rag-lewis-2020-paper-understanding-original-retrieval-augmented-generation-research)
- [The future of the vector database (InfiniFlow)](https://infiniflow.org/blog/future-vector-database), source of "the year of RAG"
- [Lost in the Middle (arXiv 2307.03172)](https://arxiv.org/abs/2307.03172v3)
- [Chain-of-Thought Prompting Elicits Reasoning in Large Language Models (NeurIPS 2022)](https://mlanthology.org/neurips/2022/wei2022neurips-chainofthought)
