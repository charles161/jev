"""One user-level check per feature in verify/features.yml. Each drives the real UI like a person would."""
import json
import math
import re
import urllib.request

from conftest import assert_no_console_errors, check
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


@check("notation-morph")
def test_notation_morph(page, skot, evidence):
    skot.new_board("checkout")
    original = labels(skot.elements())
    without_zones = labels([e for e in skot.elements() if e.get("kind") != "frame"])
    skot.clear()
    page.keyboard.press("Control+a")
    bar = page.locator(MULTI_BAR).first
    bar.wait_for(state="visible", timeout=5000)
    switcher = bar.locator('[role=tablist][aria-label="Notation morph switcher"]')
    switcher.get_by_role("tab", name="Sequence", exact=True).click()
    skot.wait_state(lambda es: any((e.get("morphMeta") or {}).get("notation") == "sequence" for e in es),
                    timeout=20, what="the sequence morph")
    page.locator('[aria-label="Refining semantic notation"]').wait_for(state="detached", timeout=20000)
    morphed = labels(skot.elements())
    skot.clear()
    page.keyboard.press("Control+a")
    page.locator(MULTI_BAR).first.locator('[role=tablist][aria-label="Notation morph switcher"]') \
        .get_by_role("tab", name="Sketch", exact=True).click()
    els = skot.wait_state(lambda es: not any((e.get("morphMeta") or {}).get("notation") not in (None, "sketch")
                                             for e in es), timeout=20, what="the morph back to sketch")
    evidence.note(original=original, sequence=morphed, back=labels(els))
    assert morphed == without_zones, "sequence morph lost nodes (zones aside): %s -> %s" % (without_zones, morphed)
    assert labels(els) == original, "morphing back lost nodes: %s -> %s" % (original, labels(els))
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
