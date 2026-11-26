#!/usr/bin/env python3
"""Packages a published Cinephage plugin build into a Jellyfin repository dir.

Usage: package.py <publish-dir> <dist-root> <version> <target-abi>

Writes <dist-root>/<target-abi>/manifest.json and the plugin zip the manifest
names. Kept in Python so the dev build script and the Docker build stage share
one packaging implementation.
"""

import datetime
import hashlib
import json
import os
import sys
import zipfile

GUID = "d912b3f3-fc4c-4c74-90e1-678616b8fe9f"
NAME = "Cinephage"
DESCRIPTION = "Lets Jellyfin play the media shortcuts Cinephage writes into your library."
OVERVIEW = "Play Cinephage library shortcuts in Jellyfin"
OWNER = "Cinephage"
CATEGORY = "General"
CHANGELOG = "First release: plays Cinephage audio shortcuts (.strm) in Jellyfin."


def main() -> None:
    publish_dir, dist_root, version, abi = sys.argv[1:5]
    parts = (version.split(".") + ["0", "0", "0"])[:4]
    version = ".".join(parts)
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    out_dir = os.path.join(dist_root, abi)
    os.makedirs(out_dir, exist_ok=True)

    meta = {
        "category": CATEGORY,
        "changelog": CHANGELOG,
        "description": DESCRIPTION,
        "guid": GUID,
        "name": NAME,
        "overview": OVERVIEW,
        "owner": OWNER,
        "targetAbi": abi,
        "timestamp": timestamp,
        "version": version,
        "status": "Active",
        "autoUpdate": True,
        "assemblies": [],
    }

    dll = os.path.join(publish_dir, "Cinephage.Plugin.Jellyfin.dll")
    zip_name = f"cinephage-jellyfin-{version}.zip"
    zip_path = os.path.join(out_dir, zip_name)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(dll, os.path.basename(dll))
        archive.writestr("meta.json", json.dumps(meta, indent=2))

    with open(zip_path, "rb") as handle:
        checksum = hashlib.md5(handle.read()).hexdigest()

    manifest = [
        {
            "guid": GUID,
            "name": NAME,
            "description": DESCRIPTION,
            "overview": OVERVIEW,
            "owner": OWNER,
            "category": CATEGORY,
            "versions": [
                {
                    "version": version,
                    "targetAbi": abi,
                    "file": zip_name,
                    "checksum": checksum,
                    "timestamp": timestamp,
                    "changelog": CHANGELOG,
                }
            ],
        }
    ]
    with open(os.path.join(out_dir, "manifest.json"), "w") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")

    print(f"built {zip_path} ({os.path.getsize(zip_path)} bytes, md5 {checksum})")


if __name__ == "__main__":
    main()
