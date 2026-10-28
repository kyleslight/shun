---
name: shun-presentations
description: Create editable PowerPoint presentations with slide layout previews using Shun's bundled presentation tool. Use for new PPTX decks and slide design.
---

# Presentations

Discover `presentation_create` with `plugin_tool_search`. It ships with Shun Desktop and creates editable text and shapes plus PNG previews from a JSON layout, without Python, an office installation, or a preview server.

Write a JSON source in the task workspace, then call the tool with `input_path` and a separate `.pptx` `output_path`. Reuse and edit this source for revisions. The tool reads current file contents on every call.

The canvas is 13.333 × 7.5 inches (16:9). Element positions and dimensions are inches; fontSize is points. Colors are six hexadecimal digits without `#`. Elements paint in array order. Supported types are `text`, `rect`, and `ellipse`; construct tables, simple charts, and diagrams from these editable elements. This tool does not import existing decks or support images, animations, or native chart objects; use an installed specialized Skill for those requirements rather than silently dropping them.

Example source:
```json
{"title":"Quarterly review","fontFace":"Arial","slides":[{"background":"10243A","elements":[{"type":"rect","x":0.6,"y":0.7,"w":0.12,"h":1.1,"fill":"00C5BB"},{"type":"text","x":1,"y":0.8,"w":11,"h":0.8,"text":"Quarterly review","fontSize":36,"bold":true,"color":"FFFFFF"},{"type":"text","x":1,"y":2,"w":10.5,"h":3,"text":"A clear takeaway supported by evidence.","fontSize":24,"color":"DCE5EE"}]}]}
```

Inspect the returned PNG paths with `read`, address overflow warnings, and check every slide before delivery. These are source-layout previews; they do not verify office-specific font substitution or wrapping. Deliver the PPTX and keep the JSON source for edits. Do not claim PowerPoint rendering was verified from these previews.

If using a different creation workflow, distinguish dependency availability, artifact creation, and rendering checks. A missing optional executable is an unavailable capability, not evidence that generation failed. Keep optional probes separate from generation commands so their exit statuses cannot obscure a successful output. Quick Look thumbnails do not validate every slide.

For HTML created by another workflow, start the server with `background_start` and `preview_url`, then inspect only its ready task-owned URL. Use `background_list`, `background_output`, and `background_stop`; do not detach a shell server or stop processes by matching generic command names.
