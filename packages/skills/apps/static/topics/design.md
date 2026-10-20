Making a page:
1. create from a template, with app.json as text: about (one sentence), rules, schema (bound lists and numbers), card ({"summary": "/count"} or {"items": "/items"}); and a plan.
2. For each component: guide <name>. Markup at <!--slot-->, script at <!--scripts-->; merge its schema into app.json. It uses the data at its data-at (all by default). Per item: `<div data-each="/habits"><template>parts</template></div>`, schemas merged into the items; data-text="name" shows a key.
3. Plain HTML; app.css styles it. Classes: stack row grow grid split card center big lead tag empty done quiet scroll.
4. Look: :root{--accent-h: 0-360; --radius: 8px} and <html data-density="compact|roomy">. One accent, no colours of your own. Motion: App.cue(el, "done|added|reveal|success|miss") when the user's own act means it; <html data-motion="calm|off"> for less.
5. Store what the user did; work out the rest (counts, time left) when drawing.
6. Every control 44 px, named, doing something. Text via textContent.
7. The empty state says what to do first.
8. The user's words beat these rules. Keep their choice as a rule tagged with the advice it overrides: "[accent] Save is neon green: asked for."
9. Small change: edit with find. New page: edit with no find.
Topics: a part's name, finish (before showing), user.
