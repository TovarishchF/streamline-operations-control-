#!/bin/sh
# Поставка для передачи: исходники для развёртывания и руководства в PDF.
#
#   make release   →   release/SOC-<дата>-<коммит>/
#
# Собирается из коммита, а не из рабочего каталога: в поставку попадает
# ровно то, что записано в истории. Что исключено — .gitattributes,
# строки export-ignore (рабочие документы, протоколы испытаний, e2e).
set -eu
cd "$(dirname "$0")/.."

if ! git diff --quiet HEAD --; then
    echo "Есть незакоммиченные изменения: поставка собирается из коммита."
    exit 1
fi
for manual in "artifacts/manuals/Руководство пользователя.pdf" \
              "artifacts/manuals/Инструкция по установке.pdf"; do
    if [ ! -f "$manual" ]; then
        echo "Нет $manual — сначала make manuals."
        exit 1
    fi
done

commit=$(git rev-parse --short HEAD)
version="$(date +%Y.%m.%d)-$commit"
out="release/SOC-$version"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

rm -rf "$out"
mkdir -p "$out" "$work/soc"

git archive --format=tar --prefix=soc/ -o "$work/soc.tar" HEAD
echo "$version" > "$work/soc/VERSION"
tar -rf "$work/soc.tar" -C "$work" soc/VERSION
gzip -9 -c "$work/soc.tar" > "$out/soc-$version.tar.gz"

cp "artifacts/manuals/Руководство пользователя.pdf" "artifacts/manuals/Инструкция по установке.pdf" "$out/"

# Проверка, что рабочие документы не попали в поставку.
if tar -tzf "$out/soc-$version.tar.gz" | grep -E '^soc/(docs|artifacts|e2e)/|^soc/(CLAUDE|README)\.md$'; then
    echo "В архив попали рабочие документы — проверьте export-ignore."
    exit 1
fi

echo "Поставка: $out"
ls -la "$out"
