#!/usr/bin/env python3
"""
Mis Finanzas — Vault Linter (adaptado de Karpathy Vault Lint)
Detecta: enlaces rotos, huérfanos, baja densidad, falta de trazabilidad en Wiki/ + MOCs/
"""

import os
import re
from pathlib import Path

# Configuración — rutas del proyecto Mis Finanzas
PROJECT_ROOT = Path(__file__).parent.parent
WIKI_PATH = PROJECT_ROOT / "Wiki"
MOCS_PATH = PROJECT_ROOT / "MOCs"
SOURCES_PATH = PROJECT_ROOT / "Sources"

# Umbrales de calidad
MIN_WORDS = 40
MIN_DENSITY = 3.0  # líneas técnicas / total (heurística simple)

def get_all_md_files(path):
    return list(path.rglob("*.md")) if path.exists() else []

def lint_vault():
    print("🚀 Iniciando Mis Finanzas Vault Lint...")

    # Crear directorios si no existen
    for p in [WIKI_PATH, MOCS_PATH, SOURCES_PATH]:
        p.mkdir(parents=True, exist_ok=True)

    all_files = get_all_md_files(WIKI_PATH) + get_all_md_files(MOCS_PATH) + get_all_md_files(SOURCES_PATH)
    file_stems = {f.stem.lower(): f for f in all_files}
    inbound_links = {f.stem.lower(): [] for f in all_files}

    broken_links = []
    low_density_files = []
    missing_sources = []
    missing_frontmatter = []

    # 1. Escaneo de enlaces, densidad, trazabilidad, frontmatter
    for file in all_files:
        content = file.read_text(encoding='utf-8', errors='ignore')

        # Extraer enlaces [[Wiki]]
        links = re.findall(r'\[\[(.*?)\]\]', content)
        for link in links:
            link_target = link.split('|')[0].strip().lower()
            if link_target in file_stems:
                inbound_links[link_target].append(file.name)
            elif link_target and not link_target.startswith(('http', '#')):
                broken_links.append((file.name, link))

        # 2. Verificar densidad en Wiki + MOCs
        if file.parent in [WIKI_PATH, MOCS_PATH]:
            word_count = len(content.split())
            if word_count < MIN_WORDS:
                low_density_files.append((file.name, f"{word_count} palabras"))

            # 3. Verificar trazabilidad (Fuente:)
            if "Fuente:" not in content and "Source:" not in content and "> [!VIDEO]" not in content:
                missing_sources.append(file.name)

            # 4. Verificar frontmatter YAML (---)
            if not content.strip().startswith("---"):
                missing_frontmatter.append(file.name)

    # 5. Detectar Huérfanos (nadie los enlaza, ignorar index y MOCs)
    orphans = []
    for stem, sources in inbound_links.items():
        if not sources and stem != "index" and not stem.startswith("moc-"):
            orphans.append(file_stems[stem].name)

    # --- REPORTE FINAL ---
    print("\n--- 📊 REPORTE DE SALUD MIS FINANZAS ---")

    print(f"\n❌ ENLACES ROTOS ({len(broken_links)}):")
    for file, link in broken_links[:10]:
        print(f"  - {file}: [[{link}]]")
    if len(broken_links) > 10: print(f"  ... y {len(broken_links)-10} más.")

    print(f"\n👻 NOTAS HUÉRFANAS ({len(orphans)}):")
    for file in orphans[:10]:
        print(f"  - {file}")
    if len(orphans) > 10: print(f"  ... y {len(orphans)-10} más.")

    print(f"\n📉 BAJA DENSIDAD (<{MIN_WORDS} palabras) ({len(low_density_files)}):")
    for file, reason in low_density_files[:10]:
        print(f"  - {file} ({reason})")

    print(f"\n🔍 FALTA TRAZABILIDAD (sin 'Fuente:') ({len(missing_sources)}):")
    for file in missing_sources[:10]:
        print(f"  - {file}")

    print(f"\n📄 SIN FRONTMATTER YAML ({len(missing_frontmatter)}):")
    for file in missing_frontmatter[:10]:
        print(f"  - {file}")

    print("\n" + "="*50)
    total_issues = len(broken_links) + len(orphans) + len(low_density_files) + len(missing_sources) + len(missing_frontmatter)
    if total_issues == 0:
        print("✅ Vault saludable. Karpathy estaría orgulloso.")
    else:
        print(f"⚠️ Se encontraron {total_issues} problemas de calidad.")
    print("="*50)

    return total_issues == 0

if __name__ == "__main__":
    success = lint_vault()
    exit(0 if success else 1)