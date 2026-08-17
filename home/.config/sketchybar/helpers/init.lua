-- Add the sketchybar module to the package cpath
package.cpath = package.cpath .. ";" .. os.getenv("HOME") .. "/.local/lib/lua/?.so"

os.execute("(cd helpers && make)")
