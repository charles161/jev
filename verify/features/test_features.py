"""One user-level check per feature in verify/features.yml. Each drives the real UI like a person would."""
import json
import math
import os
import re
import urllib.request

from conftest import REPO, assert_no_console_errors, check
from driver import center, is_shape, overlapping_pairs

THOUGHT_BAR = "Describe a component or diagram flow to draw"
SUGGESTIONS = '[role=region][aria-label="Predictive drafting suggestions"]'
FORK_PANEL = '[role=region][aria-label="Fork It architectural takes"]'
MULTI_BAR = '[role=toolbar][aria-label="Multi-selection actions"]'
# Same generic labels as GENERIC_SUGGESTION_LABELS in src/lib/jev/prediction-engine.ts.
GENERIC = ["Next Step", "Decision?", "Data Store", "Observability", "Rate Limiter", "Audit Store",
           "Core Architecture", "Parallel Group"]
# Same character class as src/brand/no-stock-icons.test.ts, applied to what the browser renders.
SCAN_UI_JS = r"""() => {
  const pict = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}]/u;
  const hits = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement && n.parentElement.closest('script, style')) continue;
    if (pict.test(n.textContent)) hits.push('text: ' + n.textContent.trim().slice(0, 60));
  }
  for (const el of document.querySelectorAll('[aria-label], [title], [placeholder], [alt]')) {
    for (const a of ['aria-label', 'title', 'placeholder', 'alt']) {
      const v = el.getAttribute(a);
      if (v && pict.test(v)) hits.push(a + ': ' + v.slice(0, 60));
    }
  }
  const stock = [...document.querySelectorAll('svg[class]')].map(s => s.getAttribute('class'))
    .filter(c => /\b(lucide|tabler-icon|heroicon|feather|fa-|phosphor|remixicon|iconify)/.test(c));
  return {pictographic: hits, stock: stock.slice(0, 10), svgCount: document.querySelectorAll('svg').length};
}"""


def labels(els):
    return sorted(e.get("label") or "" for e in els if is_shape(e))


def generic_count(titles):
    return sum(1 for t in titles if any(g.lower() in t.lower() for g in GENERIC))


ICO_TYPES = {"image/x-icon", "image/vnd.microsoft.icon"}  # both are registered names for .ico


def same_type(served, declared):
    served = served.split(";")[0].strip().lower()
    return served == declared or {served, declared} <= ICO_TYPES


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "skot-feature-verify"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status, r.headers.get("content-type", ""), r.read()


# ------------------------------------------------------------------ load, theme, brand

@check("first-load")
def test_first_load(page, skot, evidence):
    page.emulate_media(color_scheme="light")  # dark must win even when the OS prefers light
    skot.new_board()
    skot.settle(1500)
    html_class = page.evaluate("document.documentElement.className")
    bg = page.evaluate("getComputedStyle(document.body).backgroundColor")
    rgb = [int(v) for v in re.findall(r"\d+", bg)[:3]]
    toggle = page.get_by_role("button", name=re.compile("Switch to .* light theme"))
    evidence.note(url=page.url, html_dark=" dark" in " " + html_class, body_background=bg,
                  canvas=page.locator("[role=application] svg").count())
    assert page.locator("[role=application] svg").count() == 1, "the canvas did not render"
    assert "#room=" in page.url, "no room was created in the URL fragment"
    assert "dark" in html_class.split(), "html is not dark by default (class=%r)" % html_class
    assert max(rgb) < 80, "body background %s is not a dark color" % bg
    assert toggle.count() == 1, "theme toggle should offer the light theme, meaning dark is active"
    assert_no_console_errors(evidence)


@check("beta-badge")
def test_beta_badge(page, skot, evidence):
    skot.new_board()
    badge = page.get_by_role("banner").get_by_text("Beta", exact=True)
    assert badge.count() == 1, "no Beta badge in the header"
    assert badge.is_visible()
    box = badge.bounding_box()
    evidence.note(badge_box=box, badge_text=badge.inner_text())
    assert box["width"] > 10 and box["height"] > 8, "Beta badge has no visible size"
    assert_no_console_errors(evidence)


# ------------------------------------------------------------------ drawing

@check("starters")
def test_starters(page, skot, evidence):
    seen = {}
    skot.new_board("checkout")
    seen["checkout"] = labels(skot.elements())
    for want in ["Customer", "Checkout API", "Payment Gateway", "Ledger DB"]:
        assert want in seen["checkout"], "checkout starter is missing %r: %s" % (want, seen["checkout"])
    assert len(skot.arrows()) >= 4, "checkout starter has no connections"

    skot.new_board("sequence")
    skot.wait_state(lambda es: any((e.get("morphMeta") or {}).get("notation") == "sequence" for e in es),
                    timeout=20, what="the sequence starter to morph")
    seen["sequence"] = labels(skot.elements())

    skot.new_board("fork")
    page.locator(FORK_PANEL).wait_for(state="visible", timeout=20000)
    seen["fork"] = labels(skot.elements())
    seen["fork_panel"] = page.locator(FORK_PANEL).locator("[role=tab]").count()
    evidence.note(**seen)
    assert seen["fork_panel"] == 3, "Fork starter should open three takes, got %d" % seen["fork_panel"]
    assert_no_console_errors(evidence)


@check("write-to-draw")
def test_write_to_draw(page, skot, evidence):
    skot.new_board()
    bar = page.get_by_role("textbox", name=THOUGHT_BAR)
    bar.click()
    bar.fill("app -> gateway -> server")
    page.keyboard.press("Enter")
    els = skot.wait_state(lambda es: len([e for e in es if is_shape(e)]) >= 3 and
                          len([e for e in es if e.get("kind") == "arrow"]) >= 2,
                          timeout=20, what="three nodes and two arrows from the Thought Bar")
    by_id = {e["id"]: e for e in els}
    chain = [(by_id[a["fromId"]]["label"], by_id[a["toId"]]["label"]) for a in els
             if a.get("kind") == "arrow" and a.get("fromId") in by_id and a.get("toId") in by_id]
    evidence.note(nodes=labels(els), arrows=chain)
    assert [n.lower() for n in labels(els)] == ["app", "gateway", "server"], labels(els)
    assert {(f.lower(), t.lower()) for f, t in chain} == {("app", "gateway"), ("gateway", "server")}, chain
    assert bar.input_value() == "", "the Thought Bar should clear after drawing"
    assert_no_console_errors(evidence)


@check("ghost-predictions")
def test_ghost_predictions(page, skot, evidence):
    skot.new_board()
    skot.add("box", "Web App", skot.to_world(400, 260))
    before = skot.suggestion_titles()
    assert len(before) == 3, "expected three predictions after adding a node, got %s" % before
    assert before[0]["active"], "the first prediction should start active"
    skot.press("Tab")
    page.wait_for_timeout(300)
    after_tab = skot.suggestion_titles(2)
    active = [s["n"] for s in after_tab if s["active"]]
    assert active == [2], "Tab should make prediction 2 active, got %s" % after_tab
    ghosts = page.locator("[role=application] svg").evaluate("s => s.innerHTML.length")
    n_before = len(skot.shapes())
    skot.press("Enter")
    els = skot.wait_state(lambda es: len([e for e in es if is_shape(e)]) > n_before, what="Enter to apply")
    new = [e.get("label") for e in els if is_shape(e) and e.get("label") != "Web App"]
    evidence.note(predictions=[s["title"] for s in before], applied=after_tab[1]["title"], new_nodes=new,
                  svg_bytes=ghosts)
    assert new and any(n and n in after_tab[1]["title"] for n in new), \
        "Enter should add the active prediction %r, added %s" % (after_tab[1]["title"], new)
    assert any(a.get("fromId") == skot.by_label("Web App")["id"] for a in skot.arrows()), \
        "the applied prediction should connect from Web App"
    assert_no_console_errors(evidence)


@check("context-suggestions-single")
def test_context_suggestions_single(page, skot, evidence):
    skot.new_board("checkout")
    skot.clear()
    skot.click_element("Ledger DB")
    hint = page.get_by_text(re.compile(r'Next from "Ledger DB"'))
    hint.wait_for(state="visible", timeout=10000)
    titles = [s["title"] for s in skot.suggestion_titles()]
    evidence.note(selected="Ledger DB", suggestions=titles, generic=generic_count(titles))
    assert 1 <= len(titles) <= 3, "expected 1-3 suggestions for the selected node, got %s" % titles
    assert generic_count(titles) <= 1, "more than one generic suggestion: %s" % titles
    assert all(t.strip() for t in titles)
    assert_no_console_errors(evidence)


@check("context-suggestions-multi")
def test_context_suggestions_multi(page, skot, evidence):
    skot.new_board("checkout")
    skot.select("Checkout API", "Ledger DB")
    page.get_by_text("Predictions for 2 selected nodes").wait_for(state="visible", timeout=10000)
    titles = [s["title"] for s in skot.suggestion_titles()]
    evidence.note(selected=["Checkout API", "Ledger DB"], suggestions=titles)
    assert len(titles) >= 2, titles
    assert any("Checkout API" in t and "Ledger DB" in t for t in titles), \
        "one suggestion should link the two selected nodes by name: %s" % titles
    assert generic_count(titles) <= 1, "more than one generic suggestion: %s" % titles
    assert_no_console_errors(evidence)


@check("arrows-connect")
def test_arrows_connect(page, skot, evidence):
    skot.new_board()
    origin = skot.to_world(300, 300)
    cart = skot.add("box", "Cart", origin)
    pricing = skot.add("box", "Pricing", (origin[0] + 450, origin[1]))
    tax = skot.add("box", "Tax", (origin[0] + 450, origin[1] + 260))
    skot.connect("Cart", "Pricing")
    skot.clear()
    sx, sy = skot.to_screen(*center(cart))
    page.mouse.move(sx, sy)
    handle = page.locator('.jev-edge-handle[data-side="bottom"]').first
    handle.wait_for(state="visible", timeout=3000)
    hb = handle.bounding_box()
    tx, ty = skot.to_screen(*center(tax))
    page.mouse.move(hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2)
    page.mouse.down()
    page.mouse.move(tx, ty, steps=12)
    page.mouse.up()
    skot.wait_state(lambda es: any(e.get("fromId") == cart["id"] and e.get("toId") == tax["id"] for e in es),
                    what="an arrow from the edge handle drag")
    pairs = sorted((a["fromId"], a["toId"]) for a in skot.arrows())
    evidence.note(arrows=[[skot_label(skot, f), skot_label(skot, t)] for f, t in pairs])
    assert (cart["id"], pricing["id"]) in pairs and (cart["id"], tax["id"]) in pairs, pairs
    assert_no_console_errors(evidence)


def skot_label(skot, el_id):
    return next((e.get("label") for e in skot.elements() if e["id"] == el_id), None)


@check("pen-strokes")
def test_pen_strokes(page, skot, evidence):
    skot.new_board()
    x, y = skot.to_world(300, 260)
    skot.add("box", "Orders", (x, y))
    skot.add("database", "Orders DB", (x + 450, y))
    seen = {}

    skot.stroke([(x, y), (x + 150, y + 10), (x + 300, y - 5), (x + 450, y)])
    seen["connect"] = [s["title"] for s in skot.suggestion_titles()]
    assert seen["connect"] and seen["connect"][0] == "Connect Orders → Orders DB", seen["connect"]
    skot.press("Enter")
    skot.wait_state(lambda es: any(e.get("kind") == "arrow" for e in es), what="the stroke to become an arrow")
    assert not [e for e in skot.elements() if e.get("kind") == "freedraw"], "the accepted stroke should be removed"

    skot.stroke([(x, y + 250), (x + 180, y + 250), (x + 180, y + 330), (x, y + 330), (x, y + 252)])
    seen["shape"] = [s["title"] for s in skot.suggestion_titles()]
    assert seen["shape"] and all(t.startswith("Turn into a node: ") for t in seen["shape"]), seen["shape"]
    assert generic_count(seen["shape"]) == 0, "turn-into names must come from context: %s" % seen["shape"]
    n = len(skot.shapes())
    skot.press("Enter")
    skot.wait_state(lambda es: len([e for e in es if is_shape(e)]) == n + 1, what="the stroke to become a node")
    seen["shape_applied"] = seen["shape"][0].split(": ", 1)[1]
    assert seen["shape_applied"] in labels(skot.elements())

    cx, cy = x + 225, y + 36
    loop = [(cx + 420 * math.cos(a), cy + 150 * math.sin(a)) for a in [i * 2 * math.pi / 24 for i in range(25)]]
    skot.stroke(loop)
    seen["lasso"] = [s["title"] for s in skot.suggestion_titles()]
    assert seen["lasso"] and seen["lasso"][0].startswith("Group these"), seen["lasso"]
    skot.press("Enter")
    skot.wait_state(lambda es: any(e.get("kind") == "frame" for e in es), what="the lasso to become a group")
    evidence.note(**seen)
    assert not [e for e in skot.elements() if e.get("kind") == "freedraw"], "accepted strokes must not linger"
    assert_no_console_errors(evidence)


@check("fork-no-overlap")
def test_fork_no_overlap(page, skot, evidence):
    results = []
    for take in (1, 2, 3):
        skot.new_board("fork")
        panel = page.locator(FORK_PANEL)
        panel.wait_for(state="visible", timeout=20000)
        page.wait_for_function("s => !/Evaluating takes/.test(document.querySelector(s)?.textContent || '')",
                               arg=FORK_PANEL, timeout=20000)
        tabs = panel.locator("[role=tab]")
        assert tabs.count() == 3, "Fork It should offer three takes"
        title = tabs.nth(take - 1).inner_text().split("\n")
        before = len(skot.elements())
        for _ in range(take - 1):
            skot.press("Tab")
        skot.press("Enter")
        els = skot.wait_state(lambda es: len(es) != before, timeout=15, what="take %d to swap in" % take)
        panel.wait_for(state="detached", timeout=10000)
        overlaps = overlapping_pairs(els)
        results.append({"take": take, "title": [t for t in title if t.strip()][:2], "nodes": len(labels(els)),
                        "overlaps": overlaps})
        assert not overlaps, "take %d left overlapping shapes: %s" % (take, overlaps)
    evidence.note(takes=results)
    assert_no_console_errors(evidence)


NOTATION_GLYPHS = ("activation", "fragment", "initial", "final")


def node_labels(els):
    """Labels of the user's nodes: notation glyphs a morph adds (activation bars, fragments) are left out."""
    return labels([e for e in els if e.get("kind") not in NOTATION_GLYPHS])


def morph_selection(page, skot, notation, tab):
    skot.clear()
    page.keyboard.press("Control+a")
    bar = page.locator(MULTI_BAR).first
    bar.wait_for(state="visible", timeout=5000)
    bar.locator('[role=tablist][aria-label="Notation morph switcher"]').get_by_role("tab", name=tab, exact=True).click()
    if notation == "sketch":
        els = skot.wait_state(lambda es: not any((e.get("morphMeta") or {}).get("notation") not in (None, "sketch")
                                                 for e in es), timeout=20, what="the morph back to sketch")
    else:
        skot.wait_state(lambda es: any((e.get("morphMeta") or {}).get("notation") == notation for e in es),
                        timeout=20, what="the %s morph" % notation)
        page.locator('[aria-label="Refining semantic notation"]').wait_for(state="detached", timeout=20000)
        els = skot.elements()
    skot.settle(400)
    return els


@check("notation-morph")
def test_notation_morph(page, skot, evidence):
    skot.new_board("checkout")
    original = labels(skot.elements())
    without_zones = labels([e for e in skot.elements() if e.get("kind") != "frame"])

    seq = morph_selection(page, skot, "sequence", "Sequence")
    bars = [e for e in seq if e.get("kind") == "activation"]
    drawn_bars = [skot.rendered(b["id"]) for b in bars]
    back = morph_selection(page, skot, "sketch", "Sketch")
    assert node_labels(seq) == without_zones, \
        "sequence morph lost nodes (zones aside): %s -> %s" % (without_zones, node_labels(seq))
    assert bars, "the sequence morph drew no activation bars: %s" % sorted({e.get("kind") for e in seq})
    assert all(r and r["kind"] == "activation" and r["paths"] for r in drawn_bars), \
        "activation bars are stored but not drawn: %s" % drawn_bars
    assert labels(back) == original, "morphing back lost nodes: %s -> %s" % (original, labels(back))
    assert not [e for e in back if e.get("kind") == "activation"], "activation bars outlived the morph back"

    er = morph_selection(page, skot, "er", "ER")
    entities = [e for e in er if e.get("kind") == "entity"]
    rows = {e["label"]: (e.get("sublabel") or "").split("\n") for e in entities}
    relations = [a for a in er if a.get("kind") == "arrow"]
    ends = [(a.get("startEnd"), a.get("endEnd")) for a in relations]
    drawn = {a["id"]: skot.rendered(a["id"]) for a in relations}
    markers = {i: sorted({p["end"] for p in r["paths"] if p["end"]}) for i, r in drawn.items() if r}
    entity_text = {e["label"]: [t["text"] for t in (skot.rendered(e["id"]) or {"texts": []})["texts"]]
                   for e in entities}
    back_er = morph_selection(page, skot, "sketch", "Sketch")
    evidence.note(original=original, sequence=node_labels(seq), activation_bars=len(bars), back=labels(back),
                  er_rows=rows, er_ends=ends, er_markers=markers, back_from_er=labels(back_er))
    assert entities, "the ER morph made no entities: %s" % sorted({e.get("kind") for e in er})
    assert all(any(r.endswith(" PK") or " PK " in r for r in rs) for rs in rows.values()), \
        "every entity needs a PK row: %s" % rows
    assert any(" FK" in r for rs in rows.values() for r in rs), "no FK row on any entity: %s" % rows
    assert any(any(t == "PK" for t in ts) for ts in entity_text.values()), \
        "PK badges are not drawn: %s" % entity_text
    assert relations and all((s or "").startswith("er_") and (t or "").startswith("er_") for s, t in ends), \
        "every relation needs crow's-foot ends on both sides: %s" % ends
    assert all(markers.get(a["id"]) == ["end", "start"] for a in relations), \
        "crow's-foot markers are not drawn on both ends: %s" % markers
    assert labels(back_er) == original, "morphing back from ER lost nodes: %s -> %s" % (original, labels(back_er))
    assert_no_console_errors(evidence)


HLINE = re.compile(r"^M 0 ([\d.]+) L ([\d.]+) \1$")


def outline_drawn(r):
    return bool(r and any(p["d"] and p["stroke"] not in (None, "none") for p in r["paths"]))


def text_y(r, text):
    ys = [t["y"] for t in r["texts"] if t["text"] == text]
    assert ys, "%r is not drawn; drawn text: %s" % (text, [t["text"] for t in r["texts"]])
    return ys[0]


@check("more-shapes")
def test_more_shapes(page, skot, evidence):
    skot.new_board()
    o = skot.to_world(380, 300)
    queue = skot.add_more("Queue / stream", "Orders stream", o)
    entity = skot.add_more("ER entity", "orders", (o[0] + 460, o[1]))
    stored = {e["label"]: e["kind"] for e in skot.shapes()}
    drawn = {e["label"]: skot.rendered(e["id"]) for e in (queue, entity)}
    evidence.note(stored=stored, drawn_kinds={k: (v or {}).get("kind") for k, v in drawn.items()},
                  entity_text=[t["text"] for t in drawn["orders"]["texts"]] if drawn["orders"] else None)
    assert stored == {"Orders stream": "queue", "orders": "entity"}, stored
    for label, r in drawn.items():
        assert outline_drawn(r), "%r is stored but no outline is drawn: %s" % (label, r)
    assert drawn["Orders stream"]["kind"] == "queue" and drawn["orders"]["kind"] == "entity"
    assert "orders" in [t["text"] for t in drawn["orders"]["texts"]], "the entity name is not drawn"
    assert "PK" in [t["text"] for t in drawn["orders"]["texts"]], "the default PK row badge is not drawn"
    assert_no_console_errors(evidence)


@check("arrow-end-picker")
def test_arrow_end_picker(page, skot, evidence):
    skot.new_board()
    o = skot.to_world(330, 320)
    users = skot.add_more("ER entity", "users", o)
    orders = skot.add_more("ER entity", "orders", (o[0] + 520, o[1]))
    arrow = skot.connect("users", "orders")
    skot.clear()
    (ux, uy), (ox, oy) = center(users), center(orders)
    skot.click_world((ux + ox) / 2, (uy + oy) / 2)
    toolbar = page.get_by_role("toolbar", name="Selected element controls")
    ends = toolbar.get_by_role("group", name="Arrow ends")
    ends.wait_for(state="visible", timeout=5000)
    ends.get_by_role("button", name=re.compile(r"^Start end:")).click()
    page.get_by_role("button", name="Only one", exact=True).click()
    page.get_by_role("button", name="Only one", exact=True).wait_for(state="detached", timeout=3000)
    ends.get_by_role("button", name=re.compile(r"^End end:")).click()
    page.get_by_role("button", name="Zero or many", exact=True).click()
    stored = skot.wait_state(lambda es: any(e["id"] == arrow["id"] and e.get("endEnd") == "er_zero_many"
                                            for e in es), what="the end marker to be stored")
    a = next(e for e in stored if e["id"] == arrow["id"])
    r = skot.rendered(arrow["id"])
    by_end = {side: [p["d"] for p in r["paths"] if p["end"] == side] for side in ("start", "end")}
    evidence.note(startEnd=a.get("startEnd"), endEnd=a.get("endEnd"),
                  marker_paths={k: len(v) for k, v in by_end.items()},
                  start_label=ends.get_by_role("button", name=re.compile(r"^Start end:")).get_attribute("aria-label"))
    assert (a.get("startEnd"), a.get("endEnd")) == ("er_only_one", "er_zero_many"), (a.get("startEnd"), a.get("endEnd"))
    assert len(by_end["start"]) >= 2, "'only one' needs two bars at the start, drew %s" % by_end["start"]
    assert len(by_end["end"]) >= 2, "'zero or many' needs a ring and a crow's foot, drew %s" % by_end["end"]
    assert ends.get_by_role("button", name="End end: Zero or many").count() == 1, "the picker does not show the choice"
    assert_no_console_errors(evidence)


@check("multiline-rows")
def test_multiline_rows(page, skot, evidence):
    skot.new_board()
    entity = skot.add_more("ER entity", "orders", skot.to_world(380, 300))
    before = (entity.get("sublabel") or "").split("\n")
    page.get_by_role("toolbar", name="Selected element controls").get_by_role("button", name="Edit rows").click()
    editor = page.get_by_role("textbox", name="Edit entity rows")
    editor.wait_for(state="visible", timeout=3000)
    editor.press("Control+End")
    page.keyboard.press("Shift+Enter")
    page.keyboard.type("user_id uuid FK", delay=8)
    page.keyboard.press("Enter")
    els = skot.wait_state(lambda es: any(e["id"] == entity["id"] and "user_id uuid FK" in (e.get("sublabel") or "")
                                         for e in es), what="the new row to be stored")
    rows = next(e for e in els if e["id"] == entity["id"])["sublabel"].split("\n")
    texts = [t["text"] for t in skot.rendered(entity["id"])["texts"]]
    evidence.note(rows_before=before, rows_after=rows, drawn_text=texts)
    assert rows == before + ["user_id uuid FK"], "expected one new row at the end: %s -> %s" % (before, rows)
    assert page.get_by_role("textbox", name="Edit entity rows").count() == 0, "Enter should close the row editor"
    assert any("user_id" in t for t in texts), "the new row is not drawn: %s" % texts
    assert "FK" in texts, "the FK badge for the new row is not drawn: %s" % texts
    assert_no_console_errors(evidence)


@check("lld-shapes")
def test_lld_shapes(page, skot, evidence):
    skot.new_board()
    o = skot.to_world(330, 330)
    cls = skot.add_more("UML class", "Order", o)
    r = skot.rendered(cls["id"])
    dividers = sorted(float(m.group(1)) for m in (HLINE.match(p["d"]) for p in r["paths"]) if m)
    name_y, attr_y, op_y = text_y(r, "Order"), text_y(r, "- id: UUID"), text_y(r, "+ pay(): Receipt")
    seen = {"class_dividers": dividers, "class_text_y": [name_y, attr_y, op_y]}
    assert len(dividers) == 2, "a UML class needs two compartment dividers, drew %s" % dividers
    assert name_y < dividers[0] < attr_y < dividers[1] < op_y, \
        "name, attributes and operations must sit in three compartments: %s" % seen

    frag = skot.add_more("Fragment (alt/loop/opt)", "alt", (o[0] + 520, o[1] - 60))
    fr = skot.rendered(frag["id"])
    seen["fragment_text"] = [t["text"] for t in fr["texts"]]
    for want in ("alt", "[cache hit]", "[miss]"):
        text_y(fr, want)
    assert sum(1 for p in fr["paths"] if p["dash"]) == 1, "two operands need one dashed divider: %s" % fr["paths"]
    for op in ("loop", "opt"):
        skot.press("F2")
        skot.type_into_editor(op)
        skot.wait_state(lambda es: any(e["id"] == frag["id"] and e.get("label") == op for e in es),
                        what="the fragment operator %r" % op)
        skot.settle(300)
        seen["fragment_" + op] = [t["text"] for t in skot.rendered(frag["id"])["texts"]]
        assert op in seen["fragment_" + op], "the %r operator tag is not drawn: %s" % (op, seen["fragment_" + op])
    evidence.note(**seen)
    assert_no_console_errors(evidence)


@check("write-to-draw-kinds")
def test_write_to_draw_kinds(page, skot, evidence):
    skot.new_board()
    bar = page.get_by_role("textbox", name=THOUGHT_BAR)
    bar.click()
    bar.fill("kafka")
    page.keyboard.press("Enter")
    els = skot.wait_state(lambda es: any(is_shape(e) for e in es), timeout=20, what="the Thought Bar to draw")
    shapes = [(e.get("label"), e.get("kind")) for e in els if is_shape(e)]
    queue = next((e for e in els if e.get("kind") == "queue"), None)
    r = skot.rendered(queue["id"]) if queue else None
    evidence.note(shapes=shapes, drawn_kind=(r or {}).get("kind"))
    assert queue, "typing 'kafka' should draw a queue, drew %s" % shapes
    assert outline_drawn(r) and r["kind"] == "queue", "the queue is stored but not drawn: %s" % r
    assert_no_console_errors(evidence)


@check("inline-edit")
def test_inline_edit(page, skot, evidence):
    skot.new_board()
    node = skot.add("box", "Billing", skot.to_world(400, 450))
    skot.clear()
    n = len(skot.elements())
    sx, sy = skot.to_screen(*center(node))
    page.mouse.dblclick(sx, sy)
    page.wait_for_timeout(400)
    editor = page.locator('input[aria-label="Edit element label"]')
    value = editor.first.input_value() if editor.count() else None
    created = [e.get("kind") for e in skot.elements()[n:]]
    evidence.note(editor_value=value, created=created)
    assert value == "Billing", "double-click should open the node's title editor with 'Billing', got %r" % value
    assert not created, "double-click on a node created %s instead of editing it" % created
    page.keyboard.press("Control+a")
    page.keyboard.type("Invoices")
    page.keyboard.press("Enter")
    skot.wait_state(lambda es: any(e["id"] == node["id"] and e.get("label") == "Invoices" for e in es),
                    what="the edited title")
    assert_no_console_errors(evidence)


@check("zoom-keys")
def test_zoom_keys(page, skot, evidence):
    skot.new_board()
    seq = {"start": skot.zoom()}
    for key, name in [("Control+Equal", "ctrl+="), ("Control+Minus", "ctrl+-"), ("Control+Minus", "ctrl+- again"),
                      ("Control+Digit0", "ctrl+0")]:
        skot.press(key)
        page.wait_for_timeout(350)
        seq[name] = round(skot.zoom(), 3)
    browser_zoom = page.evaluate("Math.round(window.devicePixelRatio * 100) / 100")
    evidence.note(zoom=seq, devicePixelRatio=browser_zoom,
                  label=page.get_by_role("group", name="Canvas zoom controls").inner_text())
    assert seq["ctrl+="] > seq["start"], seq
    assert seq["ctrl+-"] < seq["ctrl+="] and seq["ctrl+- again"] < seq["ctrl+-"], seq
    assert seq["ctrl+0"] == 1, seq
    assert browser_zoom == 1, "the page itself zoomed instead of the canvas"
    assert "100%" in page.get_by_role("group", name="Canvas zoom controls").inner_text()
    assert_no_console_errors(evidence)


@check("duplicate-arrows")
def test_duplicate_arrows(page, skot, evidence):
    skot.new_board()
    o = skot.to_world(300, 300)
    a = skot.add("box", "Billing", o)
    b = skot.add("database", "Billing DB", (o[0] + 420, o[1]))
    arrow = skot.connect("Billing", "Billing DB")
    skot.clear()
    page.keyboard.press("Control+a")
    page.wait_for_timeout(200)
    page.keyboard.press("Control+d")
    els = skot.wait_state(lambda es: len(es) == 6, what="the duplicated nodes and arrow")
    originals = {a["id"], b["id"], arrow["id"]}
    copies = [e for e in els if e["id"] not in originals]
    copy_nodes = {e["label"]: e for e in copies if is_shape(e)}
    copy_arrows = [e for e in copies if e.get("kind") == "arrow"]
    evidence.note(copies=[(e["kind"], e.get("label"), e.get("fromId"), e.get("toId")) for e in copies])
    assert set(copy_nodes) == {"Billing", "Billing DB"}, copies
    assert len(copy_arrows) == 1, "the arrow was not duplicated: %s" % copies
    assert copy_arrows[0]["fromId"] == copy_nodes["Billing"]["id"], "copied arrow still starts at the original"
    assert copy_arrows[0]["toId"] == copy_nodes["Billing DB"]["id"], "copied arrow still ends at the original"
    dx = copy_nodes["Billing"]["x"] - a["x"]
    assert dx > 0, "the copy should be offset from the original"
    assert_no_console_errors(evidence)


# ------------------------------------------------------------------ brand surfaces

@check("no-emoji-icons")
def test_no_emoji_icons(page, skot, evidence, server):
    skot.new_board()
    scans = {"first_load": page.evaluate(SCAN_UI_JS)}
    page.get_by_role("button", name="Board menu").click()
    page.wait_for_timeout(200)
    scans["board_menu"] = page.evaluate(SCAN_UI_JS)
    page.keyboard.press("Escape")
    if server["launched"]:  # drawing calls the rank API, so production only scans the static UI
        skot.new_board("fork")
        page.locator(FORK_PANEL).wait_for(state="visible", timeout=20000)
        scans["fork_panel"] = page.evaluate(SCAN_UI_JS)
        skot.new_board("checkout")
        skot.clear()
        skot.click_element("Ledger DB")
        page.locator(SUGGESTIONS).wait_for(state="visible", timeout=10000)
        scans["suggestions_and_inspector"] = page.evaluate(SCAN_UI_JS)
    evidence.note(scans=scans)
    for state, s in scans.items():
        assert not s["pictographic"], "emoji in the %s UI: %s" % (state, s["pictographic"])
        assert not s["stock"], "stock icon set in the %s UI: %s" % (state, s["stock"])
        assert s["svgCount"] > 5, "no icons rendered in %s (icons are inline SVG)" % state
    assert_no_console_errors(evidence)


# ------------------------------------------------------------------ board import / files

IMPORT_FIXTURE = os.path.join(REPO, "src", "lib", "jev", "__fixtures__", "import-link.json")
ROOM_HASH = re.compile(r"#room=[A-Za-z0-9_-]{22,}&k=[A-Za-z0-9_-]{22,}$")


@check("board-import")
def test_board_import(page, skot, new_page, evidence, base_url, tmp_path):
    with open(IMPORT_FIXTURE, encoding="utf-8") as f:
        fixture = json.load(f)
    want = [(e["id"], e["label"]) for e in fixture["snapshot"]["elements"]]

    # 1. An #import= link (encoded by skot-bot's Python encoder) opens as a fresh room with those elements.
    page.goto(base_url + "/" + fixture["pythonHash"], wait_until="load")
    page.wait_for_function("() => /#room=/.test(location.hash)", timeout=30000)
    got = skot.wait_state(lambda els: len(els) == len(want), what="the imported board")
    assert ROOM_HASH.search(page.url) and "import=" not in page.url, "URL after import: %s" % page.url
    assert [(e["id"], e["label"]) for e in got] == want
    canvas_text = page.locator("[role=application] svg").text_content()
    assert all(label in canvas_text for _, label in want), "imported labels not drawn on the canvas"

    # 2. Save board (.json), then Open board (.json) through the file chooser: a new room, identical elements.
    page.get_by_role("button", name="Board menu").click()
    with page.expect_download() as dl:
        page.get_by_role("menuitem", name="Save board (.json)").click()
    saved_path = str(tmp_path / "board.json")
    dl.value.save_as(saved_path)
    with open(saved_path, encoding="utf-8") as f:
        saved = json.load(f)
    assert saved["format"] == "skot-board/1"
    assert saved["snapshot"]["elements"] == fixture["snapshot"]["elements"]
    first_room = page.url
    page.get_by_role("button", name="Board menu").click()
    with page.expect_file_chooser() as fc:
        page.get_by_role("menuitem", name="Open board (.json)").click()
    with page.expect_navigation(wait_until="load"):
        fc.value.set_files(saved_path)
    page.wait_for_function("() => /#room=/.test(location.hash)", timeout=30000)
    reopened = skot.wait_state(lambda els: len(els) == len(want), what="the opened board")
    assert page.url != first_room, "Open board did not start a new room"
    assert reopened == fixture["snapshot"]["elements"]
    evidence.note(imported_url=first_room, opened_url=page.url, saved_file=dl.value.suggested_filename)
    assert_no_console_errors(evidence)

    # 3. A broken link: blank board, the error toast, no console errors.
    bad = new_page("broken-link")
    bad.goto(base_url + "/" + fixture["pythonHash"][:60], wait_until="load")
    notice = bad.locator("[data-testid=board-notice]")
    notice.wait_for(state="visible", timeout=15000)
    bad.wait_for_function("() => /#room=/.test(location.hash)", timeout=30000)
    bad_skot = type(skot)(bad, base_url)
    bad_skot.settle(800)
    assert "Could not open that board" in notice.inner_text()
    assert bad_skot.elements() == [], "a broken link must leave a blank board"
    assert "import=" not in bad.url
    assert_no_console_errors(evidence)


@check("link-preview")
def test_link_preview(base_url, evidence):
    status, ctype, body = fetch(base_url + "/")
    html = body.decode("utf-8", "replace")
    meta = dict(re.findall(r'<meta (?:property|name)="((?:og|twitter):[a-z:_]+)" content="([^"]*)"', html))
    evidence.note(meta={k: v for k, v in meta.items() if k in (
        "og:title", "og:image", "og:image:type", "og:image:width", "og:image:height", "twitter:card",
        "twitter:image", "og:url")})
    assert status == 200 and "text/html" in ctype
    for key in ["og:title", "og:description", "og:image", "og:url", "twitter:card", "twitter:image"]:
        assert meta.get(key), "missing <meta %s>" % key
    assert meta["twitter:card"] == "summary_large_image"
    img = meta["og:image"]
    assert img.startswith("http"), "og:image must be an absolute URL, got %r" % img
    s, t, data = fetch(img)
    evidence.note(og_image_status=s, og_image_type=t, og_image_bytes=len(data))
    assert s == 200 and t.split(";")[0] == "image/png", "og:image %s served %s %s" % (img, s, t)
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "og:image is not a PNG"
    width, height = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    evidence.note(og_image_size=[width, height])
    assert (width, height) == (int(meta.get("og:image:width", width)), int(meta.get("og:image:height", height)))


@check("manifest-icons")
def test_manifest_icons(base_url, evidence):
    html = fetch(base_url + "/")[2].decode("utf-8", "replace")
    links = re.findall(r'<link rel="(icon|apple-touch-icon|manifest)" href="([^"]+)"(?: [^>]*type="([^"]+)")?', html)
    rels = {r for r, _, _ in links}
    assert {"icon", "apple-touch-icon", "manifest"} <= rels, "missing icon links, found %s" % links
    served = []
    for rel, href, want_type in links:
        url = href if href.startswith("http") else base_url + href
        s, t, data = fetch(url)
        served.append({"rel": rel, "href": href, "status": s, "type": t, "bytes": len(data)})
        assert s == 200 and data, "%s %s served %s" % (rel, href, s)
        if want_type:
            assert same_type(t, want_type), "%s served %s, the link says %s" % (href, t, want_type)
        if rel == "manifest":
            manifest = json.loads(data)
            assert manifest.get("name") and manifest.get("start_url") and manifest.get("display") == "standalone"
            for icon in manifest.get("icons", []):
                iu = icon["src"] if icon["src"].startswith("http") else base_url + icon["src"]
                s2, t2, d2 = fetch(iu)
                served.append({"rel": "manifest-icon", "href": icon["src"], "status": s2, "type": t2,
                               "bytes": len(d2)})
                assert s2 == 200 and t2.split(";")[0] == icon["type"], "%s served %s %s" % (icon["src"], s2, t2)
                w, h = int.from_bytes(d2[16:20], "big"), int.from_bytes(d2[20:24], "big")
                assert "%dx%d" % (w, h) == icon["sizes"], "%s is %dx%d, manifest says %s" % (iu, w, h, icon["sizes"])
            assert len(manifest.get("icons", [])) >= 2, "manifest needs 192 and 512 icons"
    evidence.note(served=served)


# ------------------------------------------------------------------ collaboration

@check("two-person-sync")
def test_two_person_sync(page, skot, new_page, evidence, base_url):
    skot.new_board()
    o = skot.to_world(400, 300)
    skot.add("box", "Shared Node", o)
    guest = new_page("guest")
    guest.goto(page.url, wait_until="load")
    guest.wait_for_selector("[role=application] svg", timeout=30000)
    has = "l => (document.querySelector('[role=application] svg')?.textContent || '').includes(l)"
    guest.wait_for_function(has, arg="Shared Node", timeout=30000)
    skot.add("box", "Live Edit", (o[0] + 400, o[1]))
    guest.wait_for_function(has, arg="Live Edit", timeout=20000)
    peers = page.get_by_role("banner").locator("button", has_text="P2P").inner_text()
    evidence.note(room=page.url.split("&")[0], host_peers_label=peers)
    assert "2" in peers, "the share button should count two peers, says %r" % peers
    assert_no_console_errors(evidence)
