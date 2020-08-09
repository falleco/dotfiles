let g:fugitive_pty = 0
autocmd FileType fugitive          nnoremap <buffer> cc :Gcommit -n<CR>
autocmd FileType fugitive          nnoremap <buffer> ca :Gcommit -n --amend<CR>
