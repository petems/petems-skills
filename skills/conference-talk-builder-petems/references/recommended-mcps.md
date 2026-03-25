# Recommended MCP Servers for Research

Check whether any of the following are connected. If any are missing, mention them to the user as options worth adding, but don't push all of them at once. Let the user know which ones would be most useful for *their specific topic*.

| MCP Server | What it's good for | Link / Install |
| --- | --- | --- |
| **DuckDuckGo** | Free general web search, no API key needed, good fallback/complement to built-in search | `nickclyde/duckduckgo-mcp-server` -- `uvx duckduckgo-mcp-server` |
| **Brave Search** (`@modelcontextprotocol/server-brave-search`) | General-purpose search with advanced operators (`site:`, `filetype:`, date ranges). 2,000 free queries/month | npmjs `@anthropic/server-brave-search` |
| **Tavily** (`tavily-mcp` or remote at `https://mcp.tavily.com/mcp/`) | Strong on technical docs, returns structured/summarised results. 1,000 free queries/month | |
| **Exa** (`exa-mcp-server`) | Semantic/neural search, great for thematic queries like "find articles about why X is like Y" rather than keyword matches | |
| **Context7** (`@upstash/context7-mcp`) | Up-to-date library/framework documentation. Invaluable if the talk involves specific tech (e.g. "what changed in Next.js 15"). Free tier available | `npx -y @upstash/context7-mcp` or remote: `https://mcp.context7.com/mcp` |
| **Paper Search** (`paper-search-mcp`) | Academic papers from arXiv, PubMed, bioRxiv, Semantic Scholar, Google Scholar, and more. Free, open-source | `https://github.com/openags/paper-search-mcp` |
| **NotebookLM** (`notebooklm-mcp`) | Research via Google NotebookLM, especially useful for YouTube transcripts and Google-ecosystem content that WebFetch/WebSearch often can't reach | `https://github.com/PleasePrompto/notebooklm-mcp` |
| **Unsplash** | Stock image search for slide visuals later. Not needed during research, but flag it now so it's ready for the slide-building stage | `https://github.com/petems/unsplash-mcp-server` (or alternatives: `hellokaton/unsplash-mcp-server`, `cevatkerim/unsplash-mcp`) |
| **Browse AI** (`browse-ai`) | Evidence-backed web research with citation and confidence scoring. Good for fact-checking claims | Via Composio or `npx -y browse-ai` |
