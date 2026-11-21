# 用无头 Edge 渲染 mermaid 图为固定尺寸 PNG
import json, os, subprocess, sys

EDGE = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
HTML = """<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{{margin:0;padding:0;background:#fff;width:{w}px;height:{h}px;overflow:hidden}}
#c{{width:{w}px;height:{h}px;display:flex;align-items:center;justify-content:center}}
#c svg{{max-width:100%;max-height:100%;height:auto;width:auto}}</style></head>
<body><div id="c"></div>
<script src="mermaid.min.js"></script>
<script>
mermaid.initialize({{startOnLoad:false,theme:'neutral',themeVariables:{{fontSize:'22px'}},flowchart:{{htmlLabels:true,curve:'basis',nodeSpacing:40,rankSpacing:70}},er:{{layoutDirection:'TB'}}}});
const code = {code};
mermaid.render('g', code).then(r => {{ document.getElementById('c').innerHTML = r.svg;
  const s = document.querySelector('#c svg');
  s.removeAttribute('height'); s.removeAttribute('width');
  s.style.maxWidth='100%'; s.style.maxHeight='100%';
  window.__done = true; }}).catch(e => {{ document.body.innerHTML = '<pre>'+e+'</pre>'; window.__done=true; }});
</script></body></html>"""

def render(name, w, h):
    code = open(f"{name}.mmd", encoding="utf-8").read()
    html = HTML.format(w=w, h=h, code=json.dumps(code))
    open(f"{name}.html", "w", encoding="utf-8").write(html)
    out = os.path.abspath(f"{name}.png")
    subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--no-sandbox",
                    "--user-data-dir=/tmp/ep-mm", "--hide-scrollbars",
                    "--virtual-time-budget=6000", f"--window-size={w},{h}",
                    f"--screenshot={out}", f"file://{os.path.abspath(name)}.html"],
                   capture_output=True)
    print("rendered", out, os.path.exists(out) and os.path.getsize(out))

if __name__ == "__main__":
    jobs = [("fig2-1-function",1800,1180), ("fig2-2-flow",1800,1510),
            ("fig3-1-er",1800,1770), ("fig3-2-arch",1800,1620)]
    for n,w,h in jobs:
        render(n,w,h)
