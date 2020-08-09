set undofile " Maintain undo history between sessions
set undodir=~/.vim/undodir
set autoread
set smartcase

highlight ColorColumn ctermbg=gray
set colorcolumn=80

set laststatus=2
set tabstop=2
set shiftwidth=2
set expandtab
set foldmethod=indent
set foldlevelstart=1000
set mouse=a
set linebreak

autocmd! bufwritepost init.vim source %

set hidden " if hidden is not set, TextEdit might fail. (COC)

set nobackup
set nowritebackup

set cmdheight=2 " Better display for messages

set shortmess+=c " don't give |ins-completion-menu| messages.

let base16colorspace=256
colorscheme base16-materia
hi Normal guibg=NONE ctermbg=NONE
set termguicolors
set number
set relativenumber

set splitbelow
set splitright

set expandtab
set shiftwidth=2

set undodir=.undo/,~/.undo/,/tmp//

noremap  <silent> <C-S>         :update<CR>
vnoremap <silent> <C-S>         <C-C>:update<CR><ESC>
inoremap <silent> <C-S>         <C-O>:update<CR><ESC>

noremap <space>tv :vsplit\|terminal<CR>a
noremap <space>ts :split\|terminal<CR>a

command! -nargs=0 Bdt :b#<bar>bd#<CR> " Kill current buffer

tnoremap <C-w> <C-\><C-n><C-w>

lua require'colorizer'.setup()

au TermOpen * setlocal nonumber norelativenumber signcolumn=no

highlight SignColumn guibg=NONE
highlight LineNr guibg=NONE
set cursorline
set fcs=eob:\ " replace tilde on empty lines with space
