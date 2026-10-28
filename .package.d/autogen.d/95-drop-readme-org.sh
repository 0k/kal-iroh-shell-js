# -*- mode: shell-script -*-
##
## npm always packs the root ``README*`` files, whatever ``files`` says,
## so ``README.org`` would ship next to the ``README.md`` generated from
## it.  Remove it, but only in the copy ``pkg`` builds the package from
## (``$workdir``, while ``pkg`` runs: it exports ``$PKG_SOURCE_DIR``):
## never in a checkout.
##

if [ -n "${PKG_SOURCE_DIR:-}" ] && [ -n "${workdir:-}" ] && [ -e README.md ] &&
       [ "$(pwd -P)" = "$(cd "$workdir" && pwd -P)" ]; then
    rm -f README.org
fi
