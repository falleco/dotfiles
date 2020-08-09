source $HOME/.config/nvim/plugins.vim
source $HOME/.config/nvim/general.vim
source $HOME/.config/nvim/coc-default.vim
source $HOME/.config/nvim/coc-git.vim
source $HOME/.config/nvim/fzf.vim
source $HOME/.config/nvim/airline.vim
source $HOME/.config/nvim/wiki.vim
source $HOME/.config/nvim/spelunker.vim
source $HOME/.config/nvim/NERDTree.vim
source $HOME/.config/nvim/fugitive.vim

let g:python2_host_prog = '/usr/bin/python'
let g:python3_host_prog = '/usr/bin/python3'

function! CopyMatches(reg)
  let hits = []
  %s//\=len(add(hits, submatch(0))) ? submatch(0) : ''/gne
  let reg = empty(a:reg) ? '+' : a:reg
  execute 'let @'.reg.' = join(hits, "\n") . "\n"'
endfunction

command! -register CopyMatches call CopyMatches(<q-reg>)

noremap <C-6> <C-^>
