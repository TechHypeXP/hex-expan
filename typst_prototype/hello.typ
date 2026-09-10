#set page(width: 5in, height: 7in, margin: 0.75in)
#set text(font: "Liberation Sans", size: 14pt)

#align(center)[
  #text(size: 28pt, weight: "bold")[hex-expan]
  #v(4pt)
  #text(size: 16pt, style: "italic")[Typst toolchain smoke test]
]

#v(1em)
This is a mechanics-only smoke test: does Typst install and compile from this
repo's Node/tsx environment and produce a valid PDF? It proves nothing about
achievable design quality (fonts, layout sophistication, graphics) -- that is
a separate, later validation with a real template.

#v(1em)
#rect(width: 100%, height: 2cm, fill: rgb("#1a5fb4"))[
  #align(center + horizon)[#text(fill: white)[A filled rectangle, to confirm basic graphics primitives render.]]
]
