#!/bin/bash

git fetch origin
git checkout origin/main

direnv allow
corepack install
pnpm install

git clone https://github.com/effect-ts/effect-smol.git --depth 1 .repos/effect
