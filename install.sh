# Make dirs
mkdir ~/.vim/undodir

# Ln

## Karabiner
ln -s -f ~/dotfiles/karabiner.json ~/.config/karabiner/karabiner.json

## ZSH
ln -s -f ~/dotfiles/zshrc ~/.zshrc
ln -s -f ~/dotfiles/zshenv ~/.zshenv

## TMUX
ln -s -f ~/dotfiles/tmux.conf ~/.tmux.conf

## Neovim
ln -s -f ~/dotfiles/nvim/ ~/.config

ln -s -f ~/dotfiles/nvim/ultisnips/ ~/.config/coc

## Vim wiki on Box
ln -s -f ~/Box/vimwiki ~/vimwiki

## Alacritty
ln -s -f ~/dotfiles/alacritty.yml ~/.config/alacritty.yml
