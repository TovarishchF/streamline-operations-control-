#!/bin/sh
# Руководства в PDF: docs/manuals/*.md → artifacts/manuals/*.pdf.
#
#   make manuals
#
# Разметка — pandoc (на машине, где собирается поставка), вёрстка страниц —
# WeasyPrint в контейнере api, тот же, что собирает печатные формы. Снимки
# экранов — docs/manuals/img, снимаются с установки для показа:
# cd e2e && npx playwright test -c manuals.config.ts
set -eu
cd "$(dirname "$0")/.."

src=docs/manuals
out=artifacts/manuals

if ! command -v pandoc >/dev/null 2>&1; then
    echo "Нужен pandoc: https://pandoc.org/installing.html"
    exit 1
fi

rm -rf "$out"
mkdir -p "$out"
cp -r "$src/img" "$src/manual.css" "$out/"
cp web/public/fonts/GolosText-Variable.woff2 web/public/fonts/Geologica-Variable.woff2 \
   web/public/fonts/JetBrainsMono-Variable.woff2 "$out/"

build() {
    pandoc "$src/$1.md" --standalone --toc --toc-depth=2 --number-sections \
        --metadata toc-title="Содержание" --css manual.css -o "$out/$1.html"
    docker compose exec -T api python -c \
        "from weasyprint import HTML; HTML('/artifacts/manuals/$1.html').write_pdf('/artifacts/manuals/$1.pdf')"
    mv "$out/$1.pdf" "$out/$2.pdf"
}

build user-guide "Руководство пользователя"
build install-guide "Инструкция по установке"

ls -la "$out"/*.pdf
